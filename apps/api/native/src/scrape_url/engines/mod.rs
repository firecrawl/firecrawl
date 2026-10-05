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

impl<T> EngineOutcome<T> {
  pub fn map<U>(self, f: impl FnOnce(T) -> U) -> EngineOutcome<U> {
    match self {
      Self::Scraped(x) => EngineOutcome::Scraped(f(x)),
      Self::ProxyElevationNeeded => EngineOutcome::ProxyElevationNeeded,
    }
  }
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

#[cfg(test)]
mod tests {
  use url_macro::url;

  use super::super::raw_page::RawPageContent;
  use super::*;

  fn scraped(status_code: u16) -> EngineOutcome<RawPageResult> {
    EngineOutcome::Scraped(RawPageResult {
      url: url!("https://example.com/"),
      status_code,
      content: RawPageContent::ChromeRenderedDOM(String::new()),
      screenshot: None,
      actions: None,
      cached_at: None,
      content_type: "text/html".to_string(),
      proxy_used: ScrapeProxy::Basic,
      timezone: None,
      filename: None,
    })
  }

  #[test]
  fn elevates_on_proxy_block_status_in_auto_mode() {
    for status in [401, 403, 429] {
      assert!(should_elevate_proxy(
        ProxyMode::Auto,
        ScrapeProxy::Basic,
        true,
        &scraped(status)
      ));
    }
  }

  #[test]
  fn does_not_elevate_on_other_statuses() {
    for status in [200, 304, 400, 404, 407, 500, 503] {
      assert!(!should_elevate_proxy(
        ProxyMode::Auto,
        ScrapeProxy::Basic,
        true,
        &scraped(status)
      ));
    }
  }

  #[test]
  fn elevates_when_engine_asks_in_auto_mode() {
    let outcome = EngineOutcome::ProxyElevationNeeded;
    assert!(should_elevate_proxy(
      ProxyMode::Auto,
      ScrapeProxy::Basic,
      true,
      &outcome
    ));
  }

  #[test]
  fn never_elevates_outside_auto_mode() {
    for mode in [ProxyMode::Basic, ProxyMode::Enhanced] {
      for proxy in [ScrapeProxy::Basic, ScrapeProxy::Enhanced] {
        assert!(!should_elevate_proxy(mode, proxy, true, &scraped(403)));
        assert!(!should_elevate_proxy(
          mode,
          proxy,
          true,
          &EngineOutcome::ProxyElevationNeeded
        ));
      }
    }
  }

  #[test]
  fn elevates_at_most_once() {
    assert!(!should_elevate_proxy(
      ProxyMode::Auto,
      ScrapeProxy::Enhanced,
      true,
      &scraped(403)
    ));
    assert!(!should_elevate_proxy(
      ProxyMode::Auto,
      ScrapeProxy::Enhanced,
      true,
      &EngineOutcome::ProxyElevationNeeded
    ));
  }

  #[test]
  fn does_not_elevate_on_status_for_engines_without_enhanced_proxies() {
    for status in [401, 403, 429] {
      assert!(!should_elevate_proxy(
        ProxyMode::Auto,
        ScrapeProxy::Basic,
        false,
        &scraped(status)
      ));
    }
  }
}
