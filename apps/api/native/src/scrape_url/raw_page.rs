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

/// A span carrying every [`RawPageResult`] field, declared here and recorded by
/// [`record_raw_page`] so the two can't drift apart. Extra creation-time fields
/// are passed through (with a trailing comma).
macro_rules! raw_page_span {
  ($name:expr, $($extra:tt)*) => {
    tracing::info_span!(
      $name,
      $($extra)*
      page.url = tracing::field::Empty,
      page.status_code = tracing::field::Empty,
      page.content_type = tracing::field::Empty,
      page.proxy_used = tracing::field::Empty,
      page.timezone = tracing::field::Empty,
      page.filename = tracing::field::Empty,
      page.cached_at = tracing::field::Empty,
      page.screenshot = tracing::field::Empty,
      page.content.kind = tracing::field::Empty,
      page.content.num_bytes = tracing::field::Empty,
      page.content.gcs_uri = tracing::field::Empty,
      page.content.sha256 = tracing::field::Empty,
      page.content.num_pages = tracing::field::Empty,
      page.content.total_pages = tracing::field::Empty,
      page.content.title = tracing::field::Empty,
      page.actions.screenshots = tracing::field::Empty,
      page.actions.scrapes = tracing::field::Empty,
      page.actions.javascript_returns = tracing::field::Empty,
      page.actions.pdfs = tracing::field::Empty,
    )
  };
}

pub(crate) use raw_page_span;

pub fn record_raw_page(span: &tracing::Span, result: &RawPageResult) {
  span.record("page.url", result.url.as_str());
  span.record("page.status_code", result.status_code);
  span.record("page.content_type", result.content_type.as_str());
  span.record("page.proxy_used", result.proxy_used.to_string());
  span.record("page.timezone", result.timezone.as_deref());
  span.record("page.filename", result.filename.as_deref());
  span.record(
    "page.cached_at",
    result.cached_at.map(|x| x.to_rfc3339()).as_deref(),
  );
  span.record(
    "page.screenshot",
    result.screenshot.as_ref().map(|x| x.as_str()),
  );

  match &result.content {
    RawPageContent::Bytes(x) => {
      span.record("page.content.kind", "bytes");
      span.record("page.content.num_bytes", x.len());
    }
    RawPageContent::BytesOffloaded(x) => {
      span.record("page.content.kind", "bytes_offloaded");
      span.record("page.content.num_bytes", x.size_bytes);
      span.record("page.content.gcs_uri", x.gcs_uri.as_str());
      span.record("page.content.sha256", x.sha256.as_str());
    }
    RawPageContent::ChromeRenderedDOM(x) => {
      span.record("page.content.kind", "chrome_rendered_dom");
      span.record("page.content.num_bytes", x.len());
    }
    RawPageContent::IndexFakeHTML(x, pdf_metadata) => {
      span.record("page.content.kind", "index_fake_html");
      span.record("page.content.num_bytes", x.len());
      if let Some(pdf_metadata) = pdf_metadata {
        span.record("page.content.num_pages", pdf_metadata.num_pages);
        span.record("page.content.total_pages", pdf_metadata.total_pages);
        span.record("page.content.title", pdf_metadata.title.as_deref());
      }
    }
    RawPageContent::GeneratedMarkdown(x) => {
      span.record("page.content.kind", "generated_markdown");
      span.record("page.content.num_bytes", x.len());
    }
  }

  if let Some(actions) = &result.actions {
    span.record("page.actions.screenshots", actions.screenshots.len());
    span.record("page.actions.scrapes", actions.scrapes.len());
    span.record(
      "page.actions.javascript_returns",
      actions.javascript_returns.len(),
    );
    span.record("page.actions.pdfs", actions.pdfs.len());
  }
}

