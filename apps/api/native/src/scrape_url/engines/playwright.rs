use std::{collections::HashMap, sync::LazyLock};

use regex::Regex;
use serde::{Deserialize, Serialize};
use url::Url;

use crate::scrape_url::engines::EngineScrapeContent;

use super::super::{
  feature_flags::{ConstFeatureFlags, FeatureFlag},
  meta::Meta,
};
use super::{Engine, EngineScrapeProxy, EngineScrapeResult, EngineSignal};

static PLAYWRIGHT_MICROSERVICE_URL: LazyLock<Option<String>> = LazyLock::new(|| {
  if let Some(url) = std::env::var("PLAYWRIGHT_MICROSERVICE_URL").ok()
    && !url.is_empty()
  {
    Some(url)
  } else {
    None
  }
});

#[derive(Serialize)]
struct PlaywrightRequest<'a> {
  url: &'a Url,
  wait_after_load: u32,
  #[serde(skip_serializing_if = "Option::is_none")]
  timeout: Option<u32>,
  headers: &'a HashMap<String, String>,
  skip_tls_verification: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlaywrightResponse {
  content: String,
  page_status_code: u16,
  content_type: Option<String>,
}

pub struct PlaywrightEngine {
  url: &'static String,
}

impl Engine for PlaywrightEngine {
  const NAME: &'static str = "playwright";
  const SPECIAL_REGEX: Option<&'static Regex> = None;
  const FEATURES: ConstFeatureFlags = ConstFeatureFlags::new(&[FeatureFlag::WaitFor]);

  async fn get() -> Option<super::EngineKind> {
    PLAYWRIGHT_MICROSERVICE_URL
      .as_ref()
      .map(|url| super::EngineKind::Playwright(Self { url }))
  }

  async fn scrape(
    &self,
    meta: &Meta,
    _proxy: EngineScrapeProxy,
  ) -> Result<EngineScrapeResult, EngineSignal> {
    let client = reqwest::Client::new(); // TODO: cache this maybe?

    let res = client
      .post(self.url)
      .json(&PlaywrightRequest {
        url: meta.get_url(),
        wait_after_load: meta.options.effective_wait_for(),
        // timeout: meta.options.timeout // TODO:
        timeout: None,
        headers: &meta.options.headers,
        skip_tls_verification: meta.options.should_skip_tls_verification(),
      })
      .send()
      .await
      .unwrap();

    if !res.status().is_success() {
      panic!("non-200"); // TODO: error handling
    }

    let body: PlaywrightResponse = res.json().await.unwrap(); // TODO: error handling

    Ok(EngineScrapeResult {
      url: meta.get_url().clone(), // TODO: improve redirect following
      content: EngineScrapeContent::ChromeRenderedDOM(body.content), // TODO: improve binary file handling
      status_code: body.page_status_code,
      content_type: body
        .content_type
        .unwrap_or_else(|| "application/octet-stream".to_string()), // TODO: improve content-type certainty
      proxy_used: EngineScrapeProxy::Basic,
      screenshot: None,
      actions: None,
      cached_at: None,
      timezone: None,
      filename: None,
    })
  }
}
