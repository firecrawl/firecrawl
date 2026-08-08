use std::sync::LazyLock;

use regex::Regex;

use super::super::{
  error::ScrapeURLError,
  feature_flags::{ConstFeatureFlags, FeatureFlag},
  meta::Meta,
};
use super::{Engine, EngineScrapeProxy, EngineScrapeResult};

static FIRE_ENGINE_BETA_URL: LazyLock<Option<String>> = LazyLock::new(|| {
  if let Some(url) = std::env::var("FIRE_ENGINE_BETA_URL").ok()
    && !url.is_empty()
  {
    Some(url)
  } else {
    None
  }
});

pub struct FireEngine {
  url: &'static String,
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
  ) -> Result<EngineScrapeResult, ScrapeURLError> {
    unimplemented!()
  }
}
