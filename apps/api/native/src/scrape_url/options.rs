use std::{collections::HashMap, fmt::Display};

use serde::{Deserialize, Serialize};

use super::{
  actions::Action,
  formats::{FormatKind, Formats},
  parsers::Parsers,
};

#[derive(Debug, PartialEq, Eq, Deserialize, Default, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum ProxyMode {
  Basic,

  #[serde(alias = "stealth")]
  Enhanced,

  #[default]
  Auto,
}

#[derive(Debug, Default, Deserialize)]
#[serde(try_from = "String")]
pub enum ScrapeOptionsLocationCountry {
  #[default]
  USGeneric, // "us-generic"

  USWhitelist,                     // "us-whitelist"
  CCA2(rust_iso3166::CountryCode), // "us", "hu", etc...
}

impl Serialize for ScrapeOptionsLocationCountry {
  fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
  where
    S: serde::Serializer,
  {
    match self {
      Self::USGeneric => serializer.serialize_str("us-generic"),
      Self::USWhitelist => serializer.serialize_str("us-whitelist"),
      Self::CCA2(x) => serializer.serialize_str(&x.alpha2.to_lowercase()),
    }
  }
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

impl Display for ScrapeOptionsLocationCountry {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      Self::CCA2(x) => f.write_str(&x.alpha2.to_lowercase()),
      Self::USGeneric => f.write_str("us-generic"),
      Self::USWhitelist => f.write_str("us-whitelist"),
    }
  }
}

impl ScrapeOptionsLocationCountry {
  /// The value the index keys on for this country. The default `us-generic` is
  /// represented as absent (stored/queried as NULL), matching the TS pipeline
  /// which sends `location?.country ?? null`.
  pub fn to_index_value(&self) -> Option<String> {
    match self {
      Self::USGeneric => None,
      other => Some(other.to_string()),
    }
  }
}

#[derive(Debug, Deserialize, Serialize, Default)]
pub struct ScrapeOptionsLocation {
  #[serde(default)]
  pub country: ScrapeOptionsLocationCountry,

  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub languages: Vec<String>,
}

fn save_changes_default() -> bool {
  true
}

#[derive(Deserialize, Serialize, Default)]
pub struct ScrapeOptionsProfile {
  // len 1-128
  pub name: String,

  #[serde(default = "save_changes_default")]
  pub save_changes: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrapeOptions {
  pub formats: Formats,
  pub headers: HashMap<String, String>,
  pub include_tags: Vec<String>,
  pub exclude_tags: Vec<String>,
  pub only_main_content: bool,
  pub only_clean_content: bool,
  pub timeout: Option<u64>,

  /// Never read this directly, always use .effective_wait_for() -> u32
  wait_for: Option<i32>,

  pub mobile: bool,
  pub parsers: Parsers,

  #[serde(default)]
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
  // #[serde(rename = "redactPII")]
  // redact_pii:
  // threat_protection:
  // audit_metadata:
  pub profile: Option<ScrapeOptionsProfile>,

  #[serde(rename = "__searchPreviewToken")]
  pub __search_preview_token: Option<String>,
  #[serde(rename = "__experimental_omce")]
  pub __experimental_omce: bool,
  #[serde(rename = "__experimental_omceDomain")]
  pub __experiemntal_omce_domain: Option<String>,
  #[serde(rename = "__experimental_engpicker")]
  pub __experiemntal_engpicker: bool,
  #[serde(rename = "__forceFirePDF")]
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
      wait_for: None,
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
      profile: None,
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

  pub fn effective_wait_for(&self) -> i32 {
    match self.wait_for {
      Some(x) => i32::min(30000, x), // cap at 30s
      None => {
        if self.formats.contains(FormatKind::Branding) {
          2000 // add some wait time for branding to avoid js errors
        } else {
          0
        }
      }
    }
  }
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct InternalOptions {
  pub crawl_id: Option<String>,
  pub priority: Option<u32>, // passed to fire-engine
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
