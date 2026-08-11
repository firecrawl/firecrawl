use std::{error::Error, fmt::Display};

use bytes::Bytes;
use chrono::{DateTime, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};
use url::Url;

use self::{
  fetch::FetchEngine, fire_engine::FireEngine, index::IndexEngine, playwright::PlaywrightEngine,
};

use super::{
  error::ScrapeURLError, feature_flags::ConstFeatureFlags, formats::FormatKind, meta::Meta,
};

mod fetch;
mod fire_engine;
mod index;
mod playwright;

#[derive(Deserialize)]
pub struct ScrapeActionContent {
  pub url: String,
  pub html: String,
}

#[derive(Deserialize)]
pub struct JavascriptActionContent {
  pub r#type: String,
  pub value: serde_json::Value,
}

pub struct EngineScrapeResultActions {
  pub screenshots: Vec<Url>,
  pub scrapes: Vec<ScrapeActionContent>,
  pub javascript_returns: Vec<JavascriptActionContent>,
  pub pdfs: Vec<Url>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EngineScrapeProxy {
  Basic,
  #[serde(alias = "stealth")]
  Enhanced,
}

impl Display for EngineScrapeProxy {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      Self::Basic => f.write_str("basic"),
      Self::Enhanced => f.write_str("enhanced"),
    }
  }
}

pub enum EngineScrapeContent {
  Bytes(Bytes),
  ChromeRenderedDOM(String),
  GeneratedMarkdown(String),
}

pub struct EngineScrapeResult {
  pub url: Url,
  pub status_code: u16,
  pub content: EngineScrapeContent,
  pub screenshot: Option<Url>,
  pub actions: Option<EngineScrapeResultActions>,
  // pub branding:
  pub cached_at: Option<DateTime<Utc>>,
  pub content_type: String, // CFR rework TODO
  // pub youtube_transcript_content:
  // pub audio_cookies:
  pub proxy_used: EngineScrapeProxy,
  pub timezone: Option<String>,
  pub filename: Option<String>,
}

pub trait Engine {
  const NAME: &'static str;
  const SPECIAL_REGEX: Option<&'static Regex>;
  const FEATURES: ConstFeatureFlags;

  async fn get() -> Option<EngineKind>;

  async fn scrape(
    &self,
    meta: &Meta,
    proxy: EngineScrapeProxy,
  ) -> Result<EngineScrapeResult, EngineSignal>;
}

pub enum EngineKind {
  Fetch(FetchEngine),
  FireEngine(FireEngine),
  Index(IndexEngine),
  Playwright(PlaywrightEngine),
}

impl EngineKind {
  pub fn get_name(self) -> &'static str {
    match self {
      EngineKind::Fetch(_) => fetch::FetchEngine::NAME,
      EngineKind::FireEngine(_) => fire_engine::FireEngine::NAME,
      EngineKind::Index(_) => index::IndexEngine::NAME,
      EngineKind::Playwright(_) => playwright::PlaywrightEngine::NAME,
    }
  }

  pub fn get_features(self) -> ConstFeatureFlags {
    match self {
      EngineKind::Fetch(_) => fetch::FetchEngine::FEATURES,
      EngineKind::FireEngine(_) => fire_engine::FireEngine::FEATURES,
      EngineKind::Index(_) => index::IndexEngine::FEATURES,
      EngineKind::Playwright(_) => playwright::PlaywrightEngine::FEATURES,
    }
  }

  pub fn special_regex(self) -> Option<&'static Regex> {
    match self {
      EngineKind::Fetch(_) => fetch::FetchEngine::SPECIAL_REGEX,
      EngineKind::FireEngine(_) => fire_engine::FireEngine::SPECIAL_REGEX,
      EngineKind::Index(_) => index::IndexEngine::SPECIAL_REGEX,
      EngineKind::Playwright(_) => playwright::PlaywrightEngine::SPECIAL_REGEX,
    }
  }

  pub async fn scrape(
    &self,
    meta: &Meta,
    proxy: EngineScrapeProxy,
  ) -> Result<EngineScrapeResult, EngineSignal> {
    match self {
      EngineKind::Fetch(x) => x.scrape(meta, proxy).await,
      EngineKind::FireEngine(x) => x.scrape(meta, proxy).await,
      EngineKind::Index(x) => x.scrape(meta, proxy).await,
      EngineKind::Playwright(x) => x.scrape(meta, proxy).await,
    }
  }

  pub async fn index() -> Option<Self> {
    IndexEngine::get().await
  }
}

pub fn should_use_index(meta: &Meta) -> bool {
  let has_custom_screenshot_settings = if let Some(screenshot) = meta.options.formats.screenshot() {
    screenshot.viewport.is_some() || screenshot.quality.is_some()
  } else {
    false
  };

  !meta.options.formats.contains(FormatKind::ChangeTracking) &&
  !meta.options.formats.contains(FormatKind::Branding) &&
  // getPDFMaxPages(meta.options.parsers) === undefined &&
  !has_custom_screenshot_settings &&
  meta.options.max_age != Some(0) &&
  meta.options.headers.is_empty() &&
  meta.options.actions.is_empty()
  // && meta.options.profile.is_none()
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

pub enum EngineSignal {
  FatalError(ScrapeURLError),
  EngineError(Box<dyn Error + Send + Sync>),
  ProxyElevationNeeded,
  IndexMiss,
}

impl Into<EngineSignal> for ScrapeURLError {
  fn into(self) -> EngineSignal {
    EngineSignal::FatalError(self)
  }
}
