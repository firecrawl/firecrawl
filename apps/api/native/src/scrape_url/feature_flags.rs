use std::collections::HashSet;

use super::{
  formats::FormatKind,
  options::{InternalOptions, ScrapeOptions},
};

#[derive(PartialEq, Eq, Hash, Clone, Copy, Debug)]
#[repr(u8)]
pub enum FeatureFlag {
  Actions,
  WaitFor,
  Screenshot,
  ScreenshotFullScreen,
  Audio,
  Video,
  Location,
  Mobile,
  Branding,
  DisableAdblock,
  // Atsv, // CFR
}

impl ToString for FeatureFlag {
  fn to_string(&self) -> String {
    match self {
      Self::Actions => "actions".to_string(),
      Self::WaitFor => "waitFor".to_string(),
      Self::Screenshot => "screenshot".to_string(),
      Self::ScreenshotFullScreen => "screenshot@fullScreen".to_string(),
      Self::Audio => "audio".to_string(),
      Self::Video => "video".to_string(),
      Self::Location => "location".to_string(),
      Self::Mobile => "mobile".to_string(),
      Self::Branding => "branding".to_string(),
      Self::DisableAdblock => "disableAdblock".to_string(),
    }
  }
}

impl FeatureFlag {
  const fn bit(self) -> u64 {
    1 << (self as u8)
  }
}

pub type FeatureFlags = HashSet<FeatureFlag>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ConstFeatureFlags(u64);

impl ConstFeatureFlags {
  pub const EMPTY: Self = Self(0);

  pub const fn new(flags: &[FeatureFlag]) -> Self {
    let mut bits = 0u64;
    let mut i = 0;
    while i < flags.len() {
      bits |= flags[i].bit();
      i += 1;
    }
    Self(bits)
  }

  pub const fn contains(self, f: FeatureFlag) -> bool {
    self.0 & f.bit() != 0
  }
  pub const fn union(self, o: Self) -> Self {
    Self(self.0 | o.0)
  }
  pub const fn is_superset(self, o: Self) -> bool {
    self.0 & o.0 == o.0
  }
}

pub fn build_feature_flags(
  options: &ScrapeOptions,
  internal_options: &InternalOptions,
) -> FeatureFlags {
  let mut flags = FeatureFlags::new();

  // if options.lockdown {
  //   // this is demented
  // }

  if !options.actions.is_empty() {
    flags.insert(FeatureFlag::Actions);
  }

  if let Some(screenshot) = options.formats.screenshot() {
    flags.insert(if screenshot.full_page {
      FeatureFlag::ScreenshotFullScreen
    } else {
      FeatureFlag::Screenshot
    });
  }

  if options.formats.contains(FormatKind::Branding) {
    flags.insert(FeatureFlag::Branding);
  }

  if options.formats.contains(FormatKind::Audio) {
    flags.insert(FeatureFlag::Audio);
  }

  if options.formats.contains(FormatKind::Video) {
    flags.insert(FeatureFlag::Video);
  }

  if options.wait_for != 0 {
    flags.insert(FeatureFlag::WaitFor);
  }

  // if internal_options.atsv // CFR

  // if options.location

  if options.mobile {
    flags.insert(FeatureFlag::Mobile);
  }

  // if options.fast_mode // CFR

  if options.block_ads == false {
    flags.insert(FeatureFlag::DisableAdblock);
  }

  flags
}
