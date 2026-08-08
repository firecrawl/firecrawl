use super::super::{
  error::ScrapeURLError,
  feature_flags::{ConstFeatureFlags, FeatureFlag},
  meta::Meta,
};
use super::{Engine, EngineScrapeProxy, EngineScrapeResult};

pub struct PlaywrightEngine;

impl Engine for PlaywrightEngine {
  const NAME: &'static str = "playwright";
  const IS_SPECIAL: bool = false;
  const FEATURES: ConstFeatureFlags = ConstFeatureFlags::new(&[FeatureFlag::WaitFor]);

  async fn scrape(
    meta: &Meta,
    proxy: EngineScrapeProxy,
  ) -> Result<EngineScrapeResult, ScrapeURLError> {
    unimplemented!()
  }
}
