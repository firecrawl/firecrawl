use std::sync::LazyLock;

use regex::Regex;
use sha2::{Digest, Sha256};

use self::{
  actions::{FireEngineActionResultCookie, FireEngineActionResultKind},
  check_status::FireEngineScrapeStatus,
  scrape::{
    FireEnginePersistentStorage, FireEngineScrapeRequest, FireEngineScrapeRequestEngine,
    FireEngineScrapeResponse,
  },
};
use super::super::{
  actions::{Action, InternalAction, InternalActionMetadata, WaitAction},
  error::ScrapeURLError,
  feature_flags::{ConstFeatureFlags, FeatureFlag},
  formats::FormatKind,
  meta::Meta,
};
use super::{
  Engine, EngineScrapeContent, EngineScrapeProxy, EngineScrapeResult, EngineScrapeResultActions,
  EngineSignal, JavascriptActionContent,
};

mod actions;
mod check_status;
mod delete;
mod scrape;

static FIRE_ENGINE_BETA_URL: LazyLock<Option<String>> = LazyLock::new(|| {
  if let Some(url) = std::env::var("FIRE_ENGINE_BETA_URL").ok()
    && !url.is_empty()
  {
    Some(url)
  } else {
    None
  }
});

#[derive(Clone, Copy)]
pub struct FireEngine {
  url: &'static String,
}

pub struct FireEngineScrape {
  pub result: EngineScrapeResult,
  pub audio_cookies: Vec<FireEngineActionResultCookie>,
}

impl FireEngine {
  pub async fn do_scrape(
    &self,
    meta: &Meta,
    proxy: EngineScrapeProxy,
    get_cookies: bool,
  ) -> Result<FireEngineScrape, EngineSignal> {
    let mut actions: Vec<InternalAction> = Vec::new();

    // Transform waitFor option into an action
    if let wait_for = meta.options.effective_wait_for()
      && wait_for > 0
    {
      actions.push(
        Action::Wait(WaitAction::Milliseconds {
          milliseconds: wait_for,
        })
        .into(),
      );
    }

    // Include user-specified actions
    actions.extend(meta.options.actions.iter().map(|x| x.to_owned().into()));

    // Transform screenshot format into an action
    if let Some(screenshot) = meta.options.formats.screenshot() {
      actions.push(
        Action::Screenshot {
          full_page: screenshot.full_page,
          viewport: screenshot.viewport.to_owned(),
          quality: screenshot.quality,
        }
        .into(),
      );
    }

    // TODO: Branding

    if meta.options.formats.contains(FormatKind::Audio)
      || meta.options.formats.contains(FormatKind::Audio)
      || get_cookies
    {
      actions.push(InternalAction {
        action: Action::GetCookies,
        metadata: Some(InternalActionMetadata {
          __firecrawl_internal: Some(true),
        }),
      });
    }

    let had_actions = !actions.is_empty();

    let request = FireEngineScrapeRequest {
      url: meta.get_url(),
      scrape_id: &meta.id,
      engine: FireEngineScrapeRequestEngine::ChromeCDP,
      instant_return: false,
      skip_tls_verification: meta.options.should_skip_tls_verification(),
      headers: &meta.options.headers,
      priority: meta.internal_options.priority,
      geolocation: &meta.options.location,
      mobile: meta.options.mobile,
      timeout: 300000, // TODO: timeout
      disable_smart_wait_cache: meta.internal_options.disable_smart_wait_cache,
      mobile_proxy: proxy == EngineScrapeProxy::Enhanced,
      max_age: meta.options.max_age,
      save_scrape_result_to_gcs: false,
      zero_data_retention: meta.internal_options.zero_data_retention,

      // Branding needs media to be loaded
      // Note: what's up with the discrepancy of Audio + Video being present on force_non_renderer vs missing here? - Mogery
      block_media: !meta.options.formats.contains(FormatKind::Branding), // TODO: youtube postprocessor? maybe? not sure if it needs media anymore

      // Branding needs media to be loaded, but not rendered.
      // On f-e, if you unblock media, it will also force it to be rendered.
      // If only branding needs media and nothing else, just force non-renderer.
      force_non_renderer: meta.options.formats.contains(FormatKind::Branding)
        && actions.iter().all(|x| x.is_renderless_safe())
        // && !meta.options.formats.contains(FormatKind::Screenshot) // NOTE: redundant check, screenshot gets mapped into actions - Mogery
        && !meta.options.formats.contains(FormatKind::Audio)
        && !meta.options.formats.contains(FormatKind::Video), // TODO: also youtube post processor

      actions,

      persistent_storage: meta.options.profile.as_ref().map(|profile| {
        FireEnginePersistentStorage {
          unique_id: format!(
            "{}_{}",
            hex::encode(&Sha256::digest(&meta.team_id)[..8]),
            profile.name
          ),
        }
      }),
    };

    let scrape = self.call_scrape(request).await;

    let (job_id, result) = match scrape {
      FireEngineScrapeResponse::Completed(x) => (x.job_id.clone(), Ok(x)),
      FireEngineScrapeResponse::Processing(x) => loop {
        match self.call_check_status(&x.job_id).await {
          FireEngineScrapeStatus::Completed(y) => break (Some(x.job_id), Ok(y)),
          FireEngineScrapeStatus::Processing(_) => {}
          FireEngineScrapeStatus::Failed(e) => break (Some(x.job_id.clone()), Err(e)),
        }
      },
      FireEngineScrapeResponse::Failed(e) => (None, Err(e)),
    };

    // Dispatch delete if deleting the job is our responsibility
    if let Some(job_id) = job_id {
      let self2 = self.clone();
      // TODO: do we need to do some sort of error handling here?
      tokio::task::spawn(async move {
        self2.call_delete(&job_id).await;
      });
    }

    let result = match result {
      Ok(x)
        if x.page_status_code == 415
          && let Some(page_error) = x.page_error.to_owned()
          && page_error.starts_with("Unsupported Media Type:") =>
      {
        Err(ScrapeURLError::UnsupportedFileError { reason: page_error }.into())
      }
      Ok(x) => Ok(x),
      Err(err) => Err(if err.retry_with_stealth {
        EngineSignal::ProxyElevationNeeded
      } else if let Some(code) = err.error.split("Chrome error: ").nth(1) {
        if code.contains("ERR_CERT_") || code.contains("ERR_SSL_") || code.contains("ERR_BAD_SSL_")
        {
          ScrapeURLError::SSLError {
            skip_tls_verification: meta.options.should_skip_tls_verification(),
          }
          .into()
        } else {
          ScrapeURLError::SiteError {
            code: code.to_string(),
          }
          .into()
        }
      } else if let Some(hostname) = err
        .error
        .split("Dns resolution error for hostname: ")
        .nth(1)
      {
        ScrapeURLError::DNSResolutionError {
          hostname: hostname.to_string(),
        }
        .into()
      } else if let Some(i) = err.error.find("File exceeds size limit") {
        ScrapeURLError::UnsupportedFileError {
          reason: err.error[i..].to_string(),
        }
        .into()
      } else if err.error.contains("failed to finish without timing out") {
        ScrapeURLError::PageLoadFailed.into()
      } else if err.error.contains("Element") || err.error.contains("Javascript execution failed") {
        // TODO: improve conditions later
        ScrapeURLError::ActionError {
          error: err.error.trim_start_matches("Error: ").to_string(),
        }
        .into()
      } else if err.error.contains("proxies available for") {
        ScrapeURLError::ProxySelectionError.into()
      } else {
        // TODO: error handling
        unimplemented!()
      }),
    }?;

    let mut screenshots_iter = result.screenshots.into_iter();

    Ok(FireEngineScrape {
      result: EngineScrapeResult {
        url: result.url.unwrap_or_else(|| meta.get_url().to_owned()),

        content: if let Some(file) = result.file.as_ref() {
          EngineScrapeContent::Bytes(
            base64::engine::Engine::decode(
              &base64::engine::general_purpose::STANDARD,
              &file.content,
            )
            .unwrap() // TODO: error handling
            .into(),
          )
        } else {
          EngineScrapeContent::ChromeRenderedDOM(result.content)
        },
        status_code: result.page_status_code,

        content_type: result
          .response_headers
          .into_iter()
          .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
          .map_or_else(|| "application/octet-stream".to_string(), |(_, v)| v),

        screenshot: if meta.options.formats.contains(FormatKind::Screenshot)
          && let Some(screenshot) = screenshots_iter.next()
        {
          Some(screenshot.to_owned())
        } else {
          None
        },

        actions: if had_actions {
          Some(EngineScrapeResultActions {
            screenshots: screenshots_iter.collect(),
            scrapes: result.action_content,
            javascript_returns: result
              .action_results
              .iter()
              .filter_map(|x| match &x.kind {
                FireEngineActionResultKind::ExecuteJavascript {
                  r#return: raw_return,
                } => serde_json::from_str::<serde_json::Value>(&raw_return)
                  .ok()
                  .map(|value| {
                    match serde_json::from_value::<JavascriptActionContent>(value.clone()) {
                      Ok(x) => x,
                      Err(_) => JavascriptActionContent {
                        r#type: "unknown".to_string(),
                        value,
                      },
                    }
                  }),
                _ => None,
              })
              .collect(),
            pdfs: result
              .action_results
              .iter()
              .filter_map(|x| match &x.kind {
                FireEngineActionResultKind::Pdf { link } => Some(link.to_owned()),
                _ => None,
              })
              .collect(),
          })
        } else {
          None
        },

        filename: result.file.map(|x| x.name),
        proxy_used: if result.used_mobile_proxy {
          EngineScrapeProxy::Enhanced
        } else {
          EngineScrapeProxy::Basic
        },
        timezone: result.timezone,

        cached_at: None,
      },

      audio_cookies: result
        .action_results
        .into_iter()
        .filter_map(|x| match x.kind {
          FireEngineActionResultKind::GetCookies { cookies } => Some(cookies),
          _ => None,
        })
        .flatten()
        .collect(),
    })
  }
}

impl Engine for FireEngine {
  const NAME: &'static str = "fire-engine";
  const SPECIAL_REGEX: Option<&'static Regex> = None;
  const FEATURES: ConstFeatureFlags = ConstFeatureFlags::new(&[
    FeatureFlag::Actions,
    FeatureFlag::WaitFor,              // through actions transform
    FeatureFlag::Screenshot,           // through actions transform
    FeatureFlag::ScreenshotFullScreen, // through actions transform
    FeatureFlag::Audio,
    FeatureFlag::Video,
    FeatureFlag::Location,
    FeatureFlag::Mobile,
    FeatureFlag::Branding,
  ]);

  async fn get() -> Option<super::EngineKind> {
    FIRE_ENGINE_BETA_URL
      .as_ref()
      .map(|url| super::EngineKind::FireEngine(Self { url }))
  }

  async fn scrape(
    &self,
    meta: &Meta,
    proxy: EngineScrapeProxy,
  ) -> Result<EngineScrapeResult, EngineSignal> {
    self.do_scrape(meta, proxy, false).await.map(|x| x.result)
  }
}
