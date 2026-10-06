//! Request bodies sent to fire-pdf.

use serde::Serialize;

use super::super::super::types::PdfMode;

/// Request metadata for fire-pdf's jobs DB and dashboards. Values of custom
/// request options are never forwarded, and ZDR requests carry no URL.
#[derive(Debug, Serialize)]
pub struct RequestMetadata<'a> {
  pub source_endpoint: &'static str,
  pub source_request_context: &'static str,
  pub source_kind: &'static str,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub url: Option<&'a str>,
}

/// Body of the sync `POST /ocr`.
#[derive(Debug, Serialize)]
pub struct OcrRequest<'a> {
  pub pdf: &'a str,
  pub scrape_id: &'a str,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub max_pages: Option<u32>,
  pub mode: PdfMode,
  #[serde(skip_serializing_if = "std::ops::Not::not")]
  pub include_page_markdown: bool,
  #[serde(skip_serializing_if = "std::ops::Not::not")]
  pub include_blocks: bool,
  #[serde(skip_serializing_if = "std::ops::Not::not")]
  pub page_markers: bool,
  pub team_id: &'a str,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub crawl_id: Option<&'a str>,
  #[serde(flatten)]
  pub metadata: RequestMetadata<'a>,
  pub pdf_sha256: &'a str,
  pub source: &'static str,
  pub zdr: bool,
  /// Remaining scrape budget handed to fire-pdf, with the moment it was handed over.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub timeout: Option<i64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub created_at: Option<i64>,
}

/// `options` of `POST /jobs` and `POST /jobs/lookup`. Both must build it
/// identically or adoption never matches the job.
#[derive(Debug, Serialize)]
pub struct JobOptionsWire {
  #[serde(skip_serializing_if = "Option::is_none")]
  pub pages_estimate: Option<u32>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub max_pages: Option<u32>,
  pub mode: PdfMode,
  #[serde(skip_serializing_if = "std::ops::Not::not")]
  pub include_page_markdown: bool,
  #[serde(skip_serializing_if = "std::ops::Not::not")]
  pub include_blocks: bool,
  /// camelCase on purpose: that is the key fire-pdf's async options schema uses.
  #[serde(rename = "pageMarkers", skip_serializing_if = "std::ops::Not::not")]
  pub page_markers: bool,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum SubmitInputWire<'a> {
  Inline {
    pdf_b64: &'a str,
  },
  ByReference {
    input_gcs_uri: &'a str,
    input_sha256: &'a str,
  },
}

/// Body of `POST /jobs`.
#[derive(Debug, Serialize)]
pub struct SubmitRequest<'a> {
  #[serde(flatten)]
  pub input: SubmitInputWire<'a>,
  pub scrape_id: &'a str,
  pub source: &'static str,
  #[serde(flatten)]
  pub metadata: RequestMetadata<'a>,
  pub zdr: bool,
  pub deadline_at: &'a str,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub team_id: Option<&'a str>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub crawl_id: Option<&'a str>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub team_concurrency: Option<u64>,
  pub options: JobOptionsWire,
}

/// Body of `POST /jobs/lookup`.
#[derive(Debug, Serialize)]
pub struct AdoptionLookupRequest<'a> {
  pub input_sha256: &'a str,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub team_id: Option<&'a str>,
  pub options: JobOptionsWire,
}

#[derive(Debug, Serialize)]
pub struct CacheLookupOptions {
  pub mode: PdfMode,
  #[serde(skip_serializing_if = "std::ops::Not::not")]
  pub include_page_markdown: bool,
  #[serde(skip_serializing_if = "std::ops::Not::not")]
  pub include_blocks: bool,
  #[serde(skip_serializing_if = "std::ops::Not::not")]
  pub page_markers: bool,
}

/// Body of the cache service's `POST /cache/lookup`.
#[derive(Debug, Serialize)]
pub struct CacheLookupRequest<'a> {
  pub keys: &'a [String],
  pub options: CacheLookupOptions,
  pub team_id: &'a str,
  pub kind: &'static str,
  pub refresh: bool,
  pub source_kind: &'static str,
  pub scrape_id: &'a str,
}
