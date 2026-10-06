//! Responses of the job, adoption and cache-lookup endpoints.

use serde::Deserialize;
use serde_json::Value;

use super::document::{
  WirePage, WirePageBlocks, deserialize_count, deserialize_ms, deserialize_pages,
};

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
