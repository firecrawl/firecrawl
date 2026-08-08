use std::{fmt::Display, sync::LazyLock};

use bytes::Bytes;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use url::Url;

use super::{
  error::ScrapeURLError, feature_flags::ConstFeatureFlags, formats::FormatKind, meta::Meta,
};

mod fetch;
mod fire_engine;
mod index;
mod playwright;

pub struct EngineScrapeResultActions {
  pub screenshots: Vec<Url>,
  // pub scrapes:
  // pub javascript_returns:
  pub pdfs: Vec<Url>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EngineScrapeProxy {
  Basic,
  #[serde(alias = "stealth")]
  Enhanced,
}

impl ToString for EngineScrapeProxy {
  fn to_string(&self) -> String {
    match self {
      Self::Basic => "basic".to_string(),
      Self::Enhanced => "enhanced".to_string(),
    }
  }
}

pub enum EngineScrapeContent {
  Bytes(Bytes),
  DecodedText(String),
}

pub struct EngineScrapeResult {
  pub url: Url,
  pub status_code: u16,
  pub content: EngineScrapeContent,
  pub screenshot: Option<String>,
  pub actions: Option<EngineScrapeResultActions>,
  // pub branding:
  // pub pdf_metadata:
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
  const IS_SPECIAL: bool;
  const FEATURES: ConstFeatureFlags;

  async fn scrape(
    meta: &Meta,
    proxy: EngineScrapeProxy,
  ) -> Result<EngineScrapeResult, ScrapeURLError>;

  #[allow(unused_variables)]
  fn special_matches(url: &Url) -> bool {
    false
  }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum EngineKind {
  Fetch,
  FireEngine,
  Index,
  Playwright,
}

impl EngineKind {
  pub fn get_name(self) -> &'static str {
    match self {
      EngineKind::Fetch => fetch::FetchEngine::NAME,
      EngineKind::FireEngine => fire_engine::FireEngine::NAME,
      EngineKind::Index => index::IndexEngine::NAME,
      EngineKind::Playwright => playwright::PlaywrightEngine::NAME,
    }
  }

  pub fn get_features(self) -> ConstFeatureFlags {
    match self {
      EngineKind::Fetch => fetch::FetchEngine::FEATURES,
      EngineKind::FireEngine => fire_engine::FireEngine::FEATURES,
      EngineKind::Index => index::IndexEngine::FEATURES,
      EngineKind::Playwright => playwright::PlaywrightEngine::FEATURES,
    }
  }

  pub fn is_special(self) -> bool {
    match self {
      EngineKind::Fetch => fetch::FetchEngine::IS_SPECIAL,
      EngineKind::FireEngine => fire_engine::FireEngine::IS_SPECIAL,
      EngineKind::Index => index::IndexEngine::IS_SPECIAL,
      EngineKind::Playwright => playwright::PlaywrightEngine::IS_SPECIAL,
    }
  }

  pub async fn scrape(
    self,
    meta: &Meta,
    proxy: EngineScrapeProxy,
  ) -> Result<EngineScrapeResult, ScrapeURLError> {
    match self {
      EngineKind::Fetch => fetch::FetchEngine::scrape(meta, proxy).await,
      EngineKind::FireEngine => fire_engine::FireEngine::scrape(meta, proxy).await,
      EngineKind::Index => index::IndexEngine::scrape(meta, proxy).await,
      EngineKind::Playwright => playwright::PlaywrightEngine::scrape(meta, proxy).await,
    }
  }

  pub fn special_matches(self, url: &Url) -> bool {
    match self {
      EngineKind::Fetch => fetch::FetchEngine::special_matches(url),
      EngineKind::FireEngine => fire_engine::FireEngine::special_matches(url),
      EngineKind::Index => index::IndexEngine::special_matches(url),
      EngineKind::Playwright => playwright::PlaywrightEngine::special_matches(url),
    }
  }
}

pub fn should_use_index(meta: &Meta) -> bool {
  let has_custom_screenshot_settings = if let Some(screenshot) = meta.options.formats.screenshot() {
    screenshot.viewport.is_some() || screenshot.quality.is_some()
  } else {
    false
  };

  *USE_INDEX &&
  !meta.options.formats.contains(FormatKind::ChangeTracking) &&
  !meta.options.formats.contains(FormatKind::Branding) &&
  // getPDFMaxPages(meta.options.parsers) === undefined &&
  !has_custom_screenshot_settings &&
  meta.options.max_age.map_or(true, |max_age| max_age != 0) &&
  meta.options.headers.is_empty() &&
  meta.options.actions.is_empty()
  // && meta.options.profile.is_none()
}

pub static MAIN_ENGINE: LazyLock<EngineKind> = LazyLock::new(|| {
  let use_fire_engine = !std::env::var("FIRE_ENGINE_BETA_URL")
    .unwrap_or("".to_string())
    .is_empty();
  let use_playwright = !std::env::var("PLAYWRIGHT_MICROSERVICE_URL")
    .unwrap_or("".to_string())
    .is_empty();

  if use_fire_engine {
    EngineKind::FireEngine
  } else if use_playwright {
    EngineKind::Playwright
  } else {
    EngineKind::Fetch
  }
});

pub static USE_INDEX: LazyLock<bool> = LazyLock::new(|| {
  !std::env::var("INDEX_DATABASE_URL")
    .unwrap_or("".to_string())
    .is_empty()
    && !std::env::var("GCS_INDEX_BUCKET_NAME")
      .unwrap_or("".to_string())
      .is_empty()
});
