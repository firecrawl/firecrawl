use std::fmt::Display;

use bytes::Bytes;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use url::Url;

use super::{
  engines::EngineKind,
  feature_flags::FeatureFlags,
  index::{Index, IndexPDFMetadata},
};

pub enum RawPageSource {
  Engine(EngineKind, FeatureFlags),
  Index,
}

impl RawPageSource {
  pub fn name(&self) -> &'static str {
    match self {
      Self::Engine(kind, _) => kind.get_name(),
      Self::Index => Index::NAME,
    }
  }

  pub fn unsupported_features(&self) -> Option<&FeatureFlags> {
    match self {
      Self::Engine(_, unsupported_features) => Some(unsupported_features),
      Self::Index => None,
    }
  }
}

pub struct RawPage {
  pub source: RawPageSource,
  pub result: RawPageResult,
  pub index_attempted: bool,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ScrapeActionContent {
  pub url: String,
  pub html: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct JavascriptActionContent {
  pub r#type: String,
  pub value: serde_json::Value,
}

#[derive(Debug, Serialize)]
pub struct RawPageActions {
  #[serde(skip_serializing_if = "Vec::is_empty")]
  pub screenshots: Vec<Url>,
  #[serde(skip_serializing_if = "Vec::is_empty")]
  pub scrapes: Vec<ScrapeActionContent>,
  #[serde(skip_serializing_if = "Vec::is_empty")]
  pub javascript_returns: Vec<JavascriptActionContent>,
  #[serde(skip_serializing_if = "Vec::is_empty")]
  pub pdfs: Vec<Url>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ScrapeProxy {
  Basic,
  #[serde(alias = "stealth")]
  Enhanced,
}

impl Display for ScrapeProxy {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      Self::Basic => f.write_str("basic"),
      Self::Enhanced => f.write_str("enhanced"),
    }
  }
}

pub struct BytesOffloaded {
  /// URI of file on GCS bucket (gs://{bucket name}/{object name})
  pub gcs_uri: String,

  /// SHA-256 hash of file
  pub sha256: String,

  /// File size in bytes
  pub size_bytes: usize,
}

pub enum RawPageContent {
  Bytes(Bytes),
  BytesOffloaded(BytesOffloaded),
  ChromeRenderedDOM(String),
  IndexFakeHTML(String, Option<IndexPDFMetadata>),
  GeneratedMarkdown(String),
}

pub struct RawPageResult {
  pub url: Url,
  pub status_code: u16,
  pub content: RawPageContent,
  pub screenshot: Option<Url>,
  pub actions: Option<RawPageActions>,
  // pub branding:
  pub cached_at: Option<DateTime<Utc>>,
  pub content_type: String, // CFR rework TODO
  // pub youtube_transcript_content:
  // pub audio_cookies:
  pub proxy_used: ScrapeProxy,
  pub timezone: Option<String>,
  pub filename: Option<String>,
}
