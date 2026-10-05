use std::sync::OnceLock;

use regex::Regex;

use self::{fetch::FetchEngine, fire_engine::FireEngine, playwright::PlaywrightEngine};

use tracing::Instrument;

use super::{
  error::ScrapeURLError,
  feature_flags::ConstFeatureFlags,
  meta::Meta,
  options::ProxyMode,
  raw_page::{RawPageResult, ScrapeProxy, raw_page_span, record_raw_page},
};

mod fetch;
mod fire_engine;
mod playwright;

pub trait Engine {
  const NAME: &'static str;
  const SPECIAL_REGEX: Option<&'static Regex>;
  const FEATURES: ConstFeatureFlags;

  async fn get() -> Option<EngineKind>;

  async fn scrape(
    &self,
    meta: &Meta,
    proxy: ScrapeProxy,
  ) -> Result<EngineOutcome<RawPageResult>, ScrapeURLError>;
}

pub enum EngineKind {
  Fetch(FetchEngine),
  FireEngine(FireEngine),
  Playwright(PlaywrightEngine),
}

impl EngineKind {
  pub fn get_name(&self) -> &'static str {
    match self {
      EngineKind::Fetch(_) => fetch::FetchEngine::NAME,
      EngineKind::FireEngine(_) => fire_engine::FireEngine::NAME,
      EngineKind::Playwright(_) => playwright::PlaywrightEngine::NAME,
    }
  }

  pub fn get_features(&self) -> ConstFeatureFlags {
    match self {
      EngineKind::Fetch(_) => fetch::FetchEngine::FEATURES,
      EngineKind::FireEngine(_) => fire_engine::FireEngine::FEATURES,
      EngineKind::Playwright(_) => playwright::PlaywrightEngine::FEATURES,
    }
  }

  /// Only fire-engine can route through enhanced proxies; the others ignore the proxy.
  pub fn supports_enhanced_proxy(&self) -> bool {
    matches!(self, EngineKind::FireEngine(_))
  }

  /// Only fire-engine can load a browser profile; the others fetch anonymously.
  pub fn supports_profile(&self) -> bool {
    matches!(self, EngineKind::FireEngine(_))
  }

  pub fn special_regex(&self) -> Option<&'static Regex> {
    match self {
      EngineKind::Fetch(_) => fetch::FetchEngine::SPECIAL_REGEX,
      EngineKind::FireEngine(_) => fire_engine::FireEngine::SPECIAL_REGEX,
      EngineKind::Playwright(_) => playwright::PlaywrightEngine::SPECIAL_REGEX,
    }
  }

  pub async fn scrape(
    &self,
    meta: &Meta,
    proxy: ScrapeProxy,
  ) -> Result<EngineOutcome<RawPageResult>, ScrapeURLError> {
    let span = raw_page_span!(
      "engine::scrape",
      engine = self.get_name(),
      proxy = ?proxy,
      outcome = tracing::field::Empty,
    );

    let outcome = async {
      match self {
        EngineKind::Fetch(x) => x.scrape(meta, proxy).await,
        EngineKind::FireEngine(x) => x.scrape(meta, proxy).await,
        EngineKind::Playwright(x) => x.scrape(meta, proxy).await,
      }
    }
    .instrument(span.clone())
    .await;

    match &outcome {
      Ok(EngineOutcome::Scraped(result)) => {
        span.record("outcome", "scraped");
        record_raw_page(&span, result);
      }
      Ok(EngineOutcome::ProxyElevationNeeded) => {
        span.record("outcome", "proxy_elevation_needed");
      }
      Err(e) => {
        span.in_scope(|| tracing::error!(error = %e));
      }
    }

    outcome
  }
}

/// Returns the client stored in `cell`, building it on first use. A failed build
/// is returned as an error and retried on the next call.
fn shared_client(
  cell: &'static OnceLock<reqwest::Client>,
) -> Result<&'static reqwest::Client, reqwest::Error> {
  if let Some(client) = cell.get() {
    return Ok(client);
  }
  let client = reqwest::Client::builder().build()?;
  Ok(cell.get_or_init(|| client))
}

pub async fn get_main_engine() -> EngineKind {
  if let Some(fire_engine) = FireEngine::get().await {
    fire_engine
  } else if let Some(playwright) = PlaywrightEngine::get().await {
    playwright
  } else {
    FetchEngine::get_guaranteed()
  }
}

pub enum EngineOutcome<T> {
  Scraped(T),
  ProxyElevationNeeded,
}

/// Whether a basic-proxy attempt in `auto` mode should be retried once with
/// enhanced proxies: the engine asked for it, or the page status (401/403/429)
/// suggests the basic proxy was inadequate and the engine can switch proxies.
pub fn should_elevate_proxy(
  mode: ProxyMode,
  attempted: ScrapeProxy,
  engine_supports_enhanced: bool,
  outcome: &EngineOutcome<RawPageResult>,
) -> bool {
  if mode != ProxyMode::Auto || attempted != ScrapeProxy::Basic {
    return false;
  }

  match outcome {
    EngineOutcome::ProxyElevationNeeded => true,
    EngineOutcome::Scraped(result) => {
      engine_supports_enhanced && matches!(result.status_code, 401 | 403 | 429)
    }
  }
}

/// Rejects a scrape the main engine can't serve, with the errors main returns.
/// Actions need an engine that runs them, and a profile must never fall back to
/// an engine that fetches anonymously.
pub fn check_engine_support(
  has_actions: bool,
  has_profile: bool,
  engine_supports_actions: bool,
  engine_supports_profile: bool,
) -> Result<(), ScrapeURLError> {
  if has_actions && !engine_supports_actions {
    return Err(ScrapeURLError::ActionsNotSupportedError);
  }

  if has_profile && !engine_supports_profile {
    return Err(ScrapeURLError::NoEnginesLeftError {
      fallback_list: Vec::new(),
    });
  }

  Ok(())
}
