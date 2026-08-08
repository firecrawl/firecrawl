use super::super::{
  error::ScrapeURLError,
  feature_flags::{ConstFeatureFlags, FeatureFlag},
  meta::Meta,
};
use super::{Engine, EngineScrapeProxy, EngineScrapeResult};

pub struct FireEngine;

impl Engine for FireEngine {
  const NAME: &'static str = "fire-engine";
  const IS_SPECIAL: bool = false;
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

  async fn scrape(
    meta: &Meta,
    proxy: EngineScrapeProxy,
  ) -> Result<EngineScrapeResult, ScrapeURLError> {
    unimplemented!()
  }
}
