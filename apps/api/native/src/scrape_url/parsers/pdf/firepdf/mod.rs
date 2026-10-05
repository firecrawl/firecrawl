//! FirePDF client: the sync `/ocr` endpoint, async `/jobs` with polling, the
//! content cache service, and large-PDF submits by GCS reference.

use std::{collections::HashSet, sync::LazyLock, time::Duration};

use sha2::{Digest, Sha256};

use self::{
  io::{HttpRequest, HttpResponse, Method},
  schema::{JobOptionsWire, Provenance, RequestMetadata},
};
use super::{super::super::meta::Meta, PdfMode, markdown_to_html};

mod by_reference;
mod cache;
mod io;
mod jobs;
mod routing;
mod schedule;
mod schema;
mod sync;
#[cfg(test)]
pub mod testing;

pub use self::{
  by_reference::{ByReferenceAttempt, Handoff, by_reference_reachable, download_handoff},
  io::{FirePdfIo, RealIo},
  jobs::AsyncInput,
  routing::{AsyncRouteInput, RouteRecord, decide_async_route, features_label},
  schema::{WirePage, WirePageBlocks},
};

/// Why a request left the fire-pdf async path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FallbackReason {
  Http400,
  Http401,
  Http404,
  Http410,
  Http413,
  Http429,
  Http502,
  Http503,
  Http5xx,
  NetworkError,
  DeadlineTooClose,
  TerminalFailed,
  TerminalExpired,
  TerminalCancelled,
  PollingTimeout,
  Result503,
}

impl FallbackReason {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Http400 => "http_400",
      Self::Http401 => "http_401",
      Self::Http404 => "http_404",
      Self::Http410 => "http_410",
      Self::Http413 => "http_413",
      Self::Http429 => "http_429",
      Self::Http502 => "http_502",
      Self::Http503 => "http_503",
      Self::Http5xx => "http_5xx",
      Self::NetworkError => "network_error",
      Self::DeadlineTooClose => "deadline_too_close",
      Self::TerminalFailed => "terminal_failed",
      Self::TerminalExpired => "terminal_expired",
      Self::TerminalCancelled => "terminal_cancelled",
      Self::PollingTimeout => "polling_timeout",
      Self::Result503 => "result_503",
    }
  }

  fn is_terminal(self) -> bool {
    matches!(
      self,
      Self::TerminalFailed | Self::TerminalExpired | Self::TerminalCancelled
    )
  }
}

#[derive(Debug, thiserror::Error)]
pub enum FirePdfError {
  #[error("fire-pdf async failed: {}", .0.as_str())]
  Async(FallbackReason),

  #[error("FirePDF request failed: {0}")]
  Transport(String),

  #[error("FirePDF responded with status {0}")]
  Status(u16),

  #[error("FirePDF response does not match the expected schema: {0}")]
  Schema(String),

  #[error("{0}")]
  Contract(&'static str),

  #[error(
    "PDF ({0} bytes) exceeds the FirePDF inline ceiling and by-reference submission was unavailable"
  )]
  InlineCeiling(usize),
}

fn env_string(name: &str) -> Option<String> {
  std::env::var(name).ok().filter(|x| !x.trim().is_empty())
}

/// zod `stringbool` semantics; anything unrecognized keeps the default.
fn env_bool(name: &str, default: bool) -> bool {
  match env_string(name)
    .map(|x| x.trim().to_ascii_lowercase())
    .as_deref()
  {
    Some("true" | "1" | "yes" | "on" | "y" | "enabled") => true,
    Some("false" | "0" | "no" | "off" | "n" | "disabled") => false,
    _ => default,
  }
}

fn env_percent(name: &str) -> f64 {
  env_string(name)
    .and_then(|x| x.trim().parse::<f64>().ok())
    .filter(|x| (0.0..=100.0).contains(x))
    .unwrap_or(0.0)
}

fn env_team_ids(name: &str) -> HashSet<String> {
  env_string(name)
    .map(|x| {
      x.split(',')
        .map(str::trim)
        .filter(|x| !x.is_empty())
        .map(str::to_string)
        .collect()
    })
    .unwrap_or_default()
}

/// FirePDF settings, read once from the same variables the TS API uses.
#[derive(Debug, Clone)]
pub struct FirePdfConfig {
  /// Master switch for FirePDF on requests that do not force it.
  pub enable: bool,
  pub base_url: Option<String>,
  pub api_key: Option<String>,
  /// fire-pdf answers cache lookups itself when set, and writes the entries.
  pub cache_base_url: Option<String>,
  /// Per-team refresh budget of the cache service; 0 disables `refresh`.
  pub cache_refresh_per_minute: u64,
  pub async_percent: f64,
  pub async_bulk_origin_percent: f64,
  pub async_force_team_ids: HashSet<String>,
  pub async_disable_team_ids: HashSet<String>,
  pub async_allow_request_override: bool,
  /// Long-poll `wait_ms` on `GET /jobs/:id`; 0 disables it.
  pub async_wait_ms: i64,
  pub by_reference_enable: bool,
  /// Receives large-PDF inputs for by-reference submits; must match fire-pdf's bucket.
  pub gcs_input_bucket: String,
  /// fire-engine's large-PDF handoff bucket, the allowlist for inbound references.
  pub fire_engine_pdf_gcs_bucket: Option<String>,
}

impl FirePdfConfig {
  fn from_env() -> Self {
    Self {
      enable: env_bool("FIRE_PDF_ENABLE", false),
      base_url: env_string("FIRE_PDF_BASE_URL"),
      api_key: env_string("FIRE_PDF_API_KEY"),
      cache_base_url: env_string("FIRE_PDF_CACHE_BASE_URL"),
      cache_refresh_per_minute: env_string("FIRE_PDF_CACHE_REFRESH_PER_MINUTE")
        .and_then(|x| x.trim().parse().ok())
        .unwrap_or(10),
      async_percent: env_percent("FIRE_PDF_ASYNC_PERCENT"),
      async_bulk_origin_percent: env_percent("FIRE_PDF_ASYNC_BULK_ORIGIN_PERCENT"),
      async_force_team_ids: env_team_ids("FIRE_PDF_ASYNC_FORCE_TEAM_IDS"),
      async_disable_team_ids: env_team_ids("FIRE_PDF_ASYNC_DISABLE_TEAM_IDS"),
      async_allow_request_override: env_bool("FIRE_PDF_ASYNC_ALLOW_REQUEST_OVERRIDE", false),
      async_wait_ms: env_string("FIRE_PDF_ASYNC_WAIT_MS")
        .and_then(|x| x.trim().parse::<i64>().ok())
        .filter(|x| *x >= 0)
        .unwrap_or(0),
      by_reference_enable: env_bool("FIRE_PDF_BY_REFERENCE_ENABLE", true),
      gcs_input_bucket: env_string("FIRE_PDF_GCS_INPUT_BUCKET")
        .map(|x| x.trim().to_string())
        .unwrap_or_else(|| "firecrawl-pdf-pipeline".to_string()),
      fire_engine_pdf_gcs_bucket: env_string("FIRE_ENGINE_PDF_GCS_BUCKET")
        .map(|x| x.trim().to_string()),
    }
  }

  pub fn get() -> &'static Self {
    static CONFIG: LazyLock<FirePdfConfig> = LazyLock::new(FirePdfConfig::from_env);
    &CONFIG
  }
}

/// What fire-pdf is handed. Raster images (one-page documents) join here with image OCR.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceKind {
  Pdf,
}

impl SourceKind {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Pdf => "pdf",
    }
  }
}

/// Per-request context every fire-pdf call carries.
#[derive(Debug, Clone)]
pub struct FirePdfRequest {
  pub scrape_id: String,
  pub team_id: String,
  pub crawl_id: Option<String>,
  /// Team's sold concurrency, for fire-pdf's per-team admission observation.
  pub team_concurrency: Option<u64>,
  pub zdr: bool,
  pub url: String,
  /// Headers, actions or a profile were supplied; their values are never forwarded.
  pub custom_request_context: bool,
  pub source_kind: SourceKind,
  /// Scrape deadline in the io clock's epoch milliseconds.
  pub deadline_ms: Option<i64>,
}

impl FirePdfRequest {
  pub fn from_meta(meta: &Meta, deadline_ms: Option<i64>) -> Self {
    let options = &meta.options;
    Self {
      scrape_id: meta.id.clone(),
      team_id: meta.team_id.clone(),
      crawl_id: meta.internal_options.crawl_id.clone(),
      team_concurrency: meta
        .internal_options
        .team_concurrency
        .filter(|x| x.is_finite() && *x > 0.0)
        .map(|x| x as u64),
      zdr: meta.internal_options.zero_data_retention,
      url: meta.get_url().to_string(),
      custom_request_context: !options.headers.is_empty()
        || !options.actions.is_empty()
        || options.profile.is_some(),
      source_kind: SourceKind::Pdf,
      deadline_ms,
    }
  }

  pub fn remaining_ms(&self, now_ms: i64) -> Option<i64> {
    self.deadline_ms.map(|deadline| deadline - now_ms)
  }

  fn metadata(&self) -> RequestMetadata<'_> {
    RequestMetadata {
      // Parse uploads do not reach the Rust pipeline yet.
      source_endpoint: "scrape",
      source_request_context: if self.custom_request_context {
        "custom"
      } else {
        "default"
      },
      source_kind: self.source_kind.as_str(),
      url: (!self.zdr).then_some(self.url.as_str()),
    }
  }
}

/// The options a FirePDF parse runs with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FirePdfJobOptions {
  pub max_pages: Option<u32>,
  /// Detected page count; 0 when unknown.
  pub pages_estimate: u32,
  pub mode: PdfMode,
  pub page_markdown: bool,
  pub blocks: bool,
  pub page_markers: bool,
  /// `refresh: true`: skip the content cache for this request.
  pub refresh: bool,
}

impl FirePdfJobOptions {
  fn wire(&self) -> JobOptionsWire {
    JobOptionsWire {
      pages_estimate: (self.pages_estimate > 0).then_some(self.pages_estimate),
      max_pages: self.max_pages,
      mode: self.mode.clone(),
      include_page_markdown: self.page_markdown,
      include_blocks: self.blocks,
      page_markers: self.page_markers,
    }
  }

  /// `fast` must fail on scanned PDFs instead of serving a cached OCR result,
  /// and an entry may have been written with a different page cap.
  pub fn cacheable(&self) -> bool {
    self.mode != PdfMode::Fast && self.max_pages.is_none_or(|n| n == 0)
  }

  /// The cache variant this request would write, for cache event labels.
  fn cache_variant(&self) -> String {
    let ocr = self.mode == PdfMode::Ocr;
    let base = match (self.page_markdown, self.blocks) {
      (true, true) => Some("page-markdown-blocks-v1"),
      (false, true) => Some("blocks-v1"),
      (true, false) => Some("page-markdown-v1"),
      (false, false) => None,
    };
    let variant = match (base, ocr) {
      (Some(base), true) => format!("ocr-{base}"),
      (Some(base), false) => base.to_string(),
      (None, true) => "ocr".to_string(),
      (None, false) => "base".to_string(),
    };
    if !self.page_markers {
      variant
    } else if variant == "base" {
      "markers-v1".to_string()
    } else if variant == "ocr" {
      "ocr-markers-v1".to_string()
    } else {
      variant.replace("-v1", "-markers-v1")
    }
  }
}

/// A FirePDF parse, from a fresh run or the content cache.
#[derive(Debug, Clone, PartialEq)]
pub struct FirePdfResult {
  pub markdown: String,
  pub html: String,
  /// Pages fire-pdf processed, or the caller's estimate when it did not say.
  pub pages_processed: u32,
  pub page_markdown: Option<Vec<WirePage>>,
  pub blocks: Option<Vec<WirePageBlocks>>,
}

impl FirePdfResult {
  async fn new(
    markdown: String,
    pages_processed: u32,
    page_markdown: Option<Vec<WirePage>>,
    blocks: Option<Vec<WirePageBlocks>>,
  ) -> Self {
    Self {
      html: markdown_to_html(&markdown).await,
      markdown,
      pages_processed,
      page_markdown,
      blocks,
    }
  }
}

/// Lowercase hex sha-256.
pub fn sha256_hex(bytes: &[u8]) -> String {
  hex::encode(Sha256::digest(bytes))
}

fn truncate(s: &str, max_chars: usize) -> &str {
  match s.char_indices().nth(max_chars) {
    Some((i, _)) => &s[..i],
    None => s,
  }
}

fn log_provenance(provenance: &Provenance, cache_key: &str) {
  if let Provenance::Malformed(issue) = provenance {
    tracing::warn!(
      cache_key,
      issue = issue.as_str(),
      "FirePDF provenance stamp not understood"
    );
  }
}

/// A FirePDF client bound to one request.
pub struct FirePdfClient<'a, I: FirePdfIo> {
  pub io: &'a I,
  pub config: &'a FirePdfConfig,
  pub base_url: &'a str,
  pub request: &'a FirePdfRequest,
}

impl<'a, I: FirePdfIo> FirePdfClient<'a, I> {
  /// `None` when FirePDF is not configured.
  pub fn new(io: &'a I, config: &'a FirePdfConfig, request: &'a FirePdfRequest) -> Option<Self> {
    Some(Self {
      base_url: config.base_url.as_deref()?,
      io,
      config,
      request,
    })
  }

  fn remaining_ms(&self) -> Option<i64> {
    self.request.remaining_ms(self.io.now_ms())
  }

  /// No request outlives the attempt's own budget: the caller window plus the polling buffer.
  async fn send(
    &self,
    method: Method,
    url: String,
    json: Option<Vec<u8>>,
    timeout: Option<Duration>,
  ) -> Result<HttpResponse, String> {
    let budget_ms =
      schedule::compute_deadline_ms(self.remaining_ms()).max(0) + schedule::POLL_TIMEOUT_BUFFER_MS;
    self
      .io
      .send(HttpRequest {
        method,
        url,
        bearer: self.config.api_key.clone(),
        json,
        timeout: timeout.or(Some(Duration::from_millis(budget_ms.unsigned_abs()))),
      })
      .await
  }
}
