//! fire-pdf wire shapes: request bodies, responses, and the provenance stamp.

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use super::super::PdfMode;

/// One physical page of markdown, 1-based.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct WirePage {
  pub page: u32,
  pub markdown: String,
}

/// Typed layout blocks of one page (fire-pdf docs/blocks-schema.md).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct WirePageBlocks {
  pub page: u32,
  pub width: Option<f64>,
  pub height: Option<f64>,
  /// Documented values are ok | partial | failed; kept open.
  pub status: String,
  pub items: Vec<WireBlockItem>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct WireBlockItem {
  pub id: String,
  pub r#type: String,
  pub label: Option<String>,
  pub bbox: Option<[f64; 4]>,
  pub content: String,
  pub markdown_span: Option<[f64; 2]>,
  pub reading_order: f64,
  pub source: Option<String>,
  pub confidence: WireBlockConfidence,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct WireBlockConfidence {
  pub layout: Option<f64>,
  pub ocr: Option<f64>,
}

fn is_page_number(value: Option<&Value>) -> bool {
  value.and_then(Value::as_u64).is_some_and(|n| n > 0)
}

fn is_nullable_number(value: Option<&Value>) -> bool {
  matches!(value, Some(Value::Null | Value::Number(_)))
}

/// `pages` as page markdown. When blocks are requested without page markdown,
/// fire-pdf sends a legacy block-alias shape here instead, which reads as absent;
/// anything that is neither fails the response.
fn deserialize_pages<'de, D: Deserializer<'de>>(
  deserializer: D,
) -> Result<Option<Vec<WirePage>>, D::Error> {
  let Some(value) = Option::<Value>::deserialize(deserializer)? else {
    return Ok(None);
  };
  let Value::Array(items) = &value else {
    return Err(serde::de::Error::custom("pages must be an array"));
  };
  let is_legacy_alias = !items.is_empty()
    && items.iter().all(|item| {
      is_page_number(item.get("page"))
        && is_nullable_number(item.get("width"))
        && is_nullable_number(item.get("height"))
        && item.get("status").is_some_and(Value::is_string)
        && item.get("blocks").is_some_and(Value::is_array)
        && item.get("markdown").is_none()
    });
  if is_legacy_alias {
    return Ok(None);
  }
  serde_json::from_value::<Vec<WirePage>>(value)
    .map(Some)
    .map_err(serde::de::Error::custom)
}

/// A present field, null included; a missing one stays `None`.
fn deserialize_present<'de, D: Deserializer<'de>>(
  deserializer: D,
) -> Result<Option<Value>, D::Error> {
  Value::deserialize(deserializer).map(Some)
}

/// Any JSON number as a page count.
fn deserialize_count<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<u32>, D::Error> {
  Ok(Option::<f64>::deserialize(deserializer)?.map(|n| n as u32))
}

/// Any JSON number as milliseconds.
fn deserialize_ms<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<i64>, D::Error> {
  Ok(Option::<f64>::deserialize(deserializer)?.map(|n| n as i64))
}

/// Shared by the sync `/ocr` response and the async `/jobs/:id/result` response.
#[derive(Debug, Deserialize)]
pub struct OcrDocument {
  pub markdown: String,
  #[serde(default, deserialize_with = "deserialize_pages")]
  pub pages: Option<Vec<WirePage>>,
  #[serde(default)]
  pub blocks: Option<Vec<WirePageBlocks>>,
  #[serde(default, deserialize_with = "deserialize_count")]
  pub pages_processed: Option<u32>,
  #[serde(default)]
  pub failed_pages: Option<Vec<f64>>,
  #[serde(default)]
  pub partial_pages: Option<Vec<f64>>,
  /// Echo of an honored page-marker request; the only proof the build understood it.
  #[serde(default)]
  pub page_markers: Option<bool>,
  /// Parsed apart from the document, so a stamp this build cannot read never fails the scrape.
  #[serde(default, deserialize_with = "deserialize_present")]
  pub provenance: Option<Value>,
}

/// `GET /jobs/:id/result`.
#[derive(Debug, Deserialize)]
pub struct ResultResponse {
  #[serde(default)]
  pub schema_version: Option<u8>,
  #[serde(flatten)]
  pub document: OcrDocument,
}

impl ResultResponse {
  pub fn parse(body: &[u8]) -> Result<Self, String> {
    let parsed: Self = serde_json::from_slice(body).map_err(|e| e.to_string())?;
    match parsed.schema_version {
      None | Some(1..=3) => Ok(parsed),
      Some(other) => Err(format!("unsupported schema_version {other}")),
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SubmitStatus {
  Queued,
  Published,
  Running,
  Done,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Lane {
  Fast,
  Standard,
  Heavy,
  Xl,
  #[default]
  Unknown,
}

impl Lane {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Fast => "fast",
      Self::Standard => "standard",
      Self::Heavy => "heavy",
      Self::Xl => "xl",
      Self::Unknown => "unknown",
    }
  }
}

/// `POST /jobs` 200/202.
#[derive(Debug, Deserialize)]
pub struct SubmitResponse {
  #[serde(rename = "scrape_id")]
  pub _scrape_id: String,
  pub status: SubmitStatus,
  #[serde(default)]
  pub lane: Lane,
  #[serde(default, deserialize_with = "deserialize_ms")]
  pub retry_after_ms: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
  Queued,
  Published,
  Running,
  Done,
  Failed,
  Expired,
  Cancelled,
}

impl JobStatus {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Queued => "queued",
      Self::Published => "published",
      Self::Running => "running",
      Self::Done => "done",
      Self::Failed => "failed",
      Self::Expired => "expired",
      Self::Cancelled => "cancelled",
    }
  }

  pub fn is_terminal(self) -> bool {
    matches!(
      self,
      Self::Done | Self::Failed | Self::Expired | Self::Cancelled
    )
  }
}

/// `GET /jobs/:id`.
#[derive(Debug, Deserialize)]
pub struct PollResponse {
  #[serde(rename = "scrape_id")]
  pub _scrape_id: String,
  pub status: JobStatus,
  #[serde(default, deserialize_with = "deserialize_ms")]
  pub retry_after_ms: Option<i64>,
  #[serde(default, deserialize_with = "deserialize_count")]
  pub pages_processed: Option<u32>,
  #[serde(default)]
  pub error_class: Option<String>,
  #[serde(default)]
  pub error_message: Option<String>,
}

/// The 503 codes fire-pdf's submit handlers document. A 503 with any other
/// body never reached a handler, so it is retried once.
pub const FIRE_PDF_SUBMIT_503_CODES: [&str; 9] = [
  "admission_rejected",
  "admission_unavailable",
  "submit_preflight_failed",
  "submit_txn_failed",
  "page_markdown_not_ready",
  "gcs_upload_failed",
  "gcs_head_failed",
  "lookup_failed",
  "internal",
];

/// fire-pdf's own 503 code, if the body carries one.
pub fn fire_pdf_503_code(body: &Value) -> Option<&str> {
  let code = body.get("error")?.as_str()?;
  let message_ok = body.get("message").is_none_or(Value::is_string);
  (message_ok && FIRE_PDF_SUBMIT_503_CODES.contains(&code)).then_some(code)
}

/// Fastify's canned reply while an instance shuts down: the request was never processed.
pub fn is_fastify_closing_body(body: &Value) -> bool {
  body.get("error").and_then(Value::as_str) == Some("Service Unavailable")
    && body.get("statusCode").and_then(Value::as_u64) == Some(503)
}

/// fire-pdf's provenance stamp: who produced a result and how complete it is.
#[derive(Debug, Deserialize)]
struct ProvenanceStamp {
  generation: String,
  build_sha: String,
  #[serde(rename = "built_at")]
  _built_at: Option<String>,
  #[serde(rename = "produced_at")]
  _produced_at: String,
  #[serde(default, rename = "stages")]
  _stages: Option<Vec<String>>,
  #[serde(default, rename = "quality")]
  _quality: Option<ProvenanceQuality>,
  #[serde(default, rename = "contributing_builds")]
  _contributing_builds: Option<Vec<ProvenanceBuild>>,
}

#[derive(Debug, Deserialize)]
struct ProvenanceQuality {
  #[serde(rename = "total_pages")]
  _total_pages: u64,
  #[serde(rename = "failed_pages")]
  _failed_pages: u64,
  #[serde(rename = "partial_pages")]
  _partial_pages: u64,
  #[serde(rename = "degraded_pages")]
  _degraded_pages: u64,
  #[serde(rename = "ocr_pages")]
  _ocr_pages: u64,
}

#[derive(Debug, Deserialize)]
struct ProvenanceBuild {
  #[serde(rename = "generation")]
  _generation: String,
  #[serde(rename = "build_sha")]
  _build_sha: String,
  #[serde(rename = "built_at")]
  _built_at: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Provenance {
  /// A build from before the stamp existed.
  Absent,
  Stamped {
    generation: String,
    build_sha: String,
  },
  Malformed(String),
}

impl Provenance {
  pub fn parse(raw: Option<&Value>) -> Self {
    match raw {
      None => Self::Absent,
      Some(Value::Null) => Self::Malformed("provenance: null".to_string()),
      Some(value) => match ProvenanceStamp::deserialize(value) {
        Ok(stamp) => Self::Stamped {
          generation: stamp.generation,
          build_sha: stamp.build_sha,
        },
        Err(e) => Self::Malformed(e.to_string()),
      },
    }
  }

  pub fn generation(&self) -> &str {
    match self {
      Self::Stamped { generation, .. } => generation,
      _ => "unknown",
    }
  }

  pub fn build_sha(&self) -> &str {
    match self {
      Self::Stamped { build_sha, .. } => build_sha,
      _ => "unknown",
    }
  }
}

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

#[derive(Debug, Deserialize)]
pub struct CachedResult {
  pub markdown: String,
  #[serde(default)]
  pub pages_processed: Option<u32>,
  #[serde(default, deserialize_with = "deserialize_pages")]
  pub pages: Option<Vec<WirePage>>,
  #[serde(default)]
  pub blocks: Option<Vec<WirePageBlocks>>,
  /// Present on entries written under a page-marker variant.
  #[serde(default)]
  pub page_markers: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "outcome", rename_all = "lowercase")]
pub enum CacheLookupOutcome {
  Hit {
    key: String,
    variant: String,
    result: Box<CachedResult>,
  },
  Stale {
    key: String,
    variant: String,
    campaign: String,
    result: Box<CachedResult>,
  },
  Miss {
    reason: String,
  },
}
