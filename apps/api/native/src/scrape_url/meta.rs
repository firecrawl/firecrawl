use std::collections::HashSet;

use url::Url;

use super::feature_flags::FeatureFlag;
use super::feature_flags::build_feature_flags;
use super::options::{InternalOptions, ScrapeOptions};
use super::rewrite_url::rewrite_url;

pub struct Meta {
  pub id: String,
  pub url: Url,
  pub team_id: String,
  pub rewritten_url: Option<Url>,
  pub options: ScrapeOptions,
  pub internal_options: InternalOptions,
  // logger:
  // abort:
  pub feature_flags: HashSet<FeatureFlag>,
  // cost_tracking:
  // winner_engine:
  // abort_handle:
  // audio_cookies:
  // warnings:
}

impl Meta {
  pub fn new(
    id: String,
    url: Url,
    team_id: String,
    options: ScrapeOptions,
    internal_options: InternalOptions,
    // cost_tracking:
  ) -> Self {
    // TODO: abortController + abortHandle, figure out how aborts will work in general

    // NOTE: isn't this fixed by rafa?
    // let ff = build_feature_flags(&options, &internal_options);
    // if internal_options.zero_data_retention {
    //   if ff.contains(&FeatureFlag::Screenshot) {
    //     // THROW
    //   } else if ff.contains(&FeatureFlag::ScreenshotFullScreen) {
    //     // THROW
    //     //} else if options.actions. find screenshot
    //     //} else if options.actions. find pdf
    //   }
    // }

    Self {
      id,
      team_id,
      rewritten_url: rewrite_url(&url),
      url,
      feature_flags: build_feature_flags(&options, &internal_options),
      options,
      internal_options,
    }
  }

  pub fn get_url(&self) -> &Url {
    match self.rewritten_url.as_ref() {
      Some(x) => x,
      None => &self.url,
    }
  }

  pub fn source_url(&self) -> String {
    self
      .internal_options
      .unnormalized_source_url
      .clone()
      .unwrap_or_else(|| self.url.to_string())
  }
}
