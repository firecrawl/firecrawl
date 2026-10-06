use std::time::Duration;

use super::{
  super::{super::super::meta::Meta, html::markdown_to_html, types::PdfMode},
  FirePdfConfig,
  io::{self, HttpRequest, HttpResponse, Method},
  schedule,
  schema::{JobOptionsWire, RequestMetadata, WirePage, WirePageBlocks},
};

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
        .filter(|x| *x > 0.0 && x.fract() == 0.0)
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

  pub(super) fn metadata(&self) -> RequestMetadata<'_> {
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
  pub(super) fn wire(&self) -> JobOptionsWire {
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
  pub(super) fn cache_variant(&self) -> String {
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
  pub(super) async fn new(
    markdown: String,
    pages_processed: u32,
    page_markdown: Option<Vec<WirePage>>,
    blocks: Option<Vec<WirePageBlocks>>,
  ) -> Self {
    let (markdown, html) = markdown_to_html(markdown).await;
    Self {
      markdown,
      html,
      pages_processed,
      page_markdown,
      blocks,
    }
  }
}

/// A FirePDF client bound to one request.
pub struct FirePdfClient<'a> {
  pub config: &'a FirePdfConfig,
  pub base_url: &'a str,
  pub request: &'a FirePdfRequest,
}

impl<'a> FirePdfClient<'a> {
  /// `None` when FirePDF is not configured.
  pub fn new(config: &'a FirePdfConfig, request: &'a FirePdfRequest) -> Option<Self> {
    Some(Self {
      base_url: config.base_url.as_deref()?,
      config,
      request,
    })
  }

  pub(super) fn remaining_ms(&self) -> Option<i64> {
    self.request.remaining_ms(io::now_ms())
  }

  /// No request outlives the attempt's own budget: the caller window plus the polling buffer.
  pub(super) async fn send(
    &self,
    method: Method,
    url: String,
    json: Option<Vec<u8>>,
    timeout: Option<Duration>,
  ) -> Result<HttpResponse, String> {
    let budget_ms =
      schedule::compute_deadline_ms(self.remaining_ms()).max(0) + schedule::POLL_TIMEOUT_BUFFER_MS;
    io::send_http(HttpRequest {
      method,
      url,
      bearer: self.config.api_key.clone(),
      json,
      timeout: timeout.or(Some(Duration::from_millis(budget_ms.unsigned_abs()))),
    })
    .await
  }
}
