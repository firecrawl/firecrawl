use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::{
  formats::{Formats, ScreenshotOptionsViewport},
  parsers::Parsers,
};

#[derive(PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProxyMode {
  Basic,

  #[serde(alias = "stealth")]
  Enhanced,

  Auto,
}

impl Default for ProxyMode {
  fn default() -> Self {
    Self::Auto
  }
}

#[derive(Default, Deserialize)]
#[serde(try_from = "String")]
pub enum ScrapeOptionsLocationCountry {
  #[default]
  USGeneric, // "us-generic"

  USWhitelist,                     // "us-whitelist"
  CCA2(rust_iso3166::CountryCode), // "us", "hu", etc...
}

impl TryFrom<String> for ScrapeOptionsLocationCountry {
  type Error = String;

  fn try_from(s: String) -> Result<Self, Self::Error> {
    match s.as_str() {
      "us-generic" => Ok(Self::USGeneric),
      "us-whitelist" => Ok(Self::USWhitelist),
      other => rust_iso3166::from_alpha2(&s.to_ascii_uppercase())
        .map(Self::CCA2)
        .ok_or_else(|| format!("unknown country code: {other}")),
    }
  }
}

impl ToString for ScrapeOptionsLocationCountry {
  fn to_string(&self) -> String {
    match self {
      Self::CCA2(x) => x.alpha2.to_lowercase(),
      Self::USGeneric => "us-generic".to_string(),
      Self::USWhitelist => "us-whitelist".to_string(),
    }
  }
}

#[derive(Deserialize, Default)]
pub struct ScrapeOptionsLocation {
  #[serde(default)]
  pub country: ScrapeOptionsLocationCountry,

  #[serde(default)]
  pub languages: Vec<String>,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ActionScrollDirection {
  Up,

  #[default]
  Down,
}

fn default_scale() -> f64 {
  1.
}

#[derive(Serialize, Deserialize, Default)]
pub enum ActionPdfFormat {
  A0,
  A1,
  A2,
  A3,
  A4,
  A5,
  A6,

  #[default]
  Letter,

  Legal,
  Tabloid,
  Ledger,
}

#[derive(Serialize, Deserialize)]
#[serde(untagged, deny_unknown_fields)]
pub enum WaitAction {
  Selector { selector: String },
  Milliseconds { milliseconds: u32 },
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Action {
  Wait(WaitAction),
  Click {
    selector: String,
    #[serde(default)]
    all: bool,
  },
  Screenshot {
    full_page: bool,
    quality: Option<u8>,
    viewport: Option<ScreenshotOptionsViewport>,
  },
  Write {
    text: String,
  },
  Press {
    key: String,
  },
  Scroll {
    #[serde(default)]
    direction: ActionScrollDirection,

    selector: Option<String>,
  },
  Scrape,
  ExecuteJavascript {
    script: String,
  },
  Pdf {
    #[serde(default)]
    landscape: bool,

    #[serde(default = "default_scale")]
    scale: f64,

    #[serde(default)]
    format: ActionPdfFormat,
  },
}

#[derive(Deserialize)]
pub struct ScrapeOptions {
  pub formats: Formats,
  pub headers: HashMap<String, String>,
  pub include_tags: Vec<String>,
  pub exclude_tags: Vec<String>,
  pub only_main_content: bool,
  pub only_clean_content: bool,
  pub timeout: Option<u64>,
  pub wait_for: u64,
  pub mobile: bool,
  pub parsers: Parsers,
  pub actions: Vec<Action>,

  // #[serde(default)]
  pub location: ScrapeOptionsLocation,

  /// Never read this directly, always use .should_skip_tls_verification() -> bool
  skip_tls_verification: Option<bool>,

  pub remove_base64_images: bool,
  // fast_mode: bool, // candidate for removal
  // use_mock: bool, // candidate for removal
  pub block_ads: bool,
  pub proxy: ProxyMode,
  pub max_age: Option<i32>,
  pub min_age: Option<i32>,
  pub store_in_cache: bool,
  pub lockdown: bool,
  // redact_pii:
  // threat_protection:
  // audit_metadata:
  // profile:
  pub __search_preview_token: Option<String>,
  pub __experimental_omce: bool,
  pub __experiemntal_omce_domain: Option<String>,
  pub __experiemntal_engpicker: bool,
  pub __force_fire_pdf: bool,
}

impl Default for ScrapeOptions {
  fn default() -> Self {
    Self {
      formats: Default::default(),
      headers: Default::default(),
      include_tags: Vec::with_capacity(0),
      exclude_tags: Vec::with_capacity(0),
      only_main_content: true,
      only_clean_content: false,
      timeout: None,
      wait_for: 0,
      mobile: false,
      parsers: Default::default(),
      actions: Vec::with_capacity(0),
      location: Default::default(),
      skip_tls_verification: None,
      remove_base64_images: true,
      block_ads: true,
      proxy: Default::default(),
      max_age: None,
      min_age: None,
      store_in_cache: true,
      lockdown: false,
      __search_preview_token: None,
      __experimental_omce: false,
      __experiemntal_omce_domain: None,
      __experiemntal_engpicker: false,
      __force_fire_pdf: false,
    }
  }
}

impl ScrapeOptions {
  pub fn should_skip_tls_verification(&self) -> bool {
    match self.skip_tls_verification {
      Some(x) => x,

      // If the user does not send headers or actions to the site, we deem it safe
      // to disable TLS verification by default.
      None => self.headers.is_empty() && self.actions.is_empty(),
    }
  }
}

pub struct InternalOptions {
  pub crawl_id: Option<String>,
  pub priority: Option<u64>, // passed to fire-engine
  // force_engine: // candidate for removal
  // atsv: // candidate for removal
  pub v0_crawl_only_urls: bool,
  pub v0_disable_jsdom: bool,
  pub disable_smart_wait_cache: bool, // passed to fire-engine
  pub is_background_index: bool,
  // external_abort: // TODO
  pub url_invisible_in_current_crawl: bool,
  pub unnormalized_source_url: Option<String>,

  pub save_scrape_result_to_gcs: bool, // passed to fire-engine
  pub bypass_billing: bool,
  pub zero_data_retention: bool,
  // team_flags: Option<TeamFlags>, // TODO

  // v1_agent:
  // v1_json_agent:
  // v1_json_system_prompt: String
  // v1_original_format: extract | json
  pub agent_index_only: bool, // pre-confirmation agent key: serve from index only, never touch web/Fire Engine // CFR
  // is_parse:
  pub is_pre_crawl: bool, // whether this scrape is part of a precrawl job
}

impl Default for InternalOptions {
  fn default() -> Self {
    Self {
      crawl_id: None,
      priority: None,
      v0_crawl_only_urls: false,
      v0_disable_jsdom: false,
      disable_smart_wait_cache: false,
      is_background_index: false,
      url_invisible_in_current_crawl: false,
      unnormalized_source_url: None,
      save_scrape_result_to_gcs: false, // not used anymore i think
      bypass_billing: false,
      zero_data_retention: false,
      agent_index_only: false,
      is_pre_crawl: false,
    }
  }
}
