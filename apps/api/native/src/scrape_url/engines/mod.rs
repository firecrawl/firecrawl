use regex::Regex;

use self::{fetch::FetchEngine, fire_engine::FireEngine, playwright::PlaywrightEngine};

use super::{
  error::ScrapeURLError,
  feature_flags::ConstFeatureFlags,
  meta::Meta,
  raw_page::{RawPageResult, ScrapeProxy},
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
    match self {
      EngineKind::Fetch(x) => x.scrape(meta, proxy).await,
      EngineKind::FireEngine(x) => x.scrape(meta, proxy).await,
      EngineKind::Playwright(x) => x.scrape(meta, proxy).await,
    }
  }
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
