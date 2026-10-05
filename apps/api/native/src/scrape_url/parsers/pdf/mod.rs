use std::{
  fmt::Display,
  sync::{Arc, LazyLock},
};

use base64::Engine;
use bytes::Bytes;
use pdf_inspector::{PdfProcessResult, PdfType};
use serde::{Deserialize, Serialize};
use tracing::warn;
use ts_rs::TS;
use tokio::{sync::Semaphore, time::Instant};
use tracing::{Span, field::Empty};

use self::firepdf::{
  AsyncInput, AsyncRouteInput, ByReferenceAttempt, FirePdfClient, FirePdfConfig, FirePdfIo,
  FirePdfJobOptions, FirePdfRequest, FirePdfResult, Handoff, RealIo, RouteRecord, WirePage,
  WirePageBlocks, by_reference_reachable, decide_async_route, download_handoff, features_label,
  sha256_hex,
};
use super::super::{
  document::{Document, DocumentMetadata, DocumentMetadataCacheState},
  error::ScrapeURLError,
  meta::Meta,
  raw_page::{RawPageContent, RawPageResult},
};

mod firepdf;

#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize, TS)]
pub use self::firepdf::FirePdfError;

/// Above this, FirePDF submits go by GCS reference instead of inline base64.
const FIRE_PDF_MAX_FILE_SIZE: usize = 30 * 1024 * 1024;
/// fire-pdf's 100MB body limit over base64 inflation, with margin for the envelope.
const FIRE_PDF_INLINE_HARD_MAX_FILE_SIZE: usize = 70 * 1024 * 1024;
/// Unparsed PDFs come back base64'd inline, so they keep a tighter cap.
const PDF_DOWNLOAD_MAX_FILE_SIZE: usize = 50 * 1024 * 1024;
/// OCR time budget per page.
const MILLISECONDS_PER_PAGE: u64 = 150;

#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PdfMode {
  #[default]
  Auto,

  Fast,
  Ocr,
}

#[derive(Debug, Clone, Serialize, TS)]
/// One physical page of markdown, as surfaced on `Document.pages`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfPage {
  /// 1-based physical page number.
  pub page_number: u32,
  pub markdown: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PdfBlockItemConfidence {
  pub layout: Option<f64>,
  pub ocr: Option<f64>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PdfBlockItem {
  pub id: String,
  pub r#type: String,
  pub label: Option<String>,
  pub bbox: Option<[f64; 4]>,
  pub content: String,
  pub markdown_span: Option<[f64; 2]>,
  pub reading_order: f64,
  pub source: Option<String>,
  pub confidence: PdfBlockItemConfidence,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct PdfPage {
  pub page: u32,
  pub markdown: String,
/// Typed layout blocks of one page, as surfaced on `Document.blocks`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfPageBlocks {
  pub page_number: u32,
  pub width: Option<f64>,
  pub height: Option<f64>,
  pub status: String,
  pub items: Vec<PdfBlockItem>,
}

impl From<WirePage> for PdfPage {
  fn from(page: WirePage) -> Self {
    Self {
      page_number: page.page,
      markdown: page.markdown,
    }
  }
}

impl From<WirePageBlocks> for PdfPageBlocks {
  fn from(page: WirePageBlocks) -> Self {
    Self {
      page_number: page.page,
      width: page.width,
      height: page.height,
      status: page.status,
      items: page
        .items
        .into_iter()
        .map(|item| PdfBlockItem {
          id: item.id,
          r#type: item.r#type,
          label: item.label,
          bbox: item.bbox,
          content: item.content,
          markdown_span: item.markdown_span,
          reading_order: item.reading_order,
          source: item.source,
          confidence: PdfBlockItemConfidence {
            layout: item.confidence.layout,
            ocr: item.confidence.ocr,
          },
        })
        .collect(),
    }
  }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields = nullable)]
pub struct PdfOptions {
  #[serde(default)]
  #[ts(as = "Option<_>", optional)]
  pub mode: PdfMode,

  pub max_pages: Option<u32>,

  /// Include physical per-page markdown alongside document markdown.
  #[serde(default)]
  #[ts(as = "Option<_>", optional)]
  pub pages: bool,

  /// Include per-page types layout blocks (bounding boxes, block types, reading order) alongside document markdown.
  #[serde(default)]
  #[ts(as = "Option<_>", optional)]
  pub blocks: bool,

  /// Join PDF pages in `document.markdown` with `\n\n---\n\n<!-- page N -->\n\n` where N is the 1-based physical page
  /// of the content that follows. Markers appear between pages only (no leading marker for page 1), and numbering may
  /// skip pages merged by cross-page stitching — callers that need every physical page should use `pages: true` instead.
  /// No new response field.
  #[serde(default)]
  #[ts(as = "Option<_>", optional)]
  pub page_markers: bool,

  /// Skip the cached conversion for this document and parse it again; the fresh result replaces the cache entry.
  #[serde(default)]
  pub refresh: bool,

  /// Experimental opt-in to fire-pdf's async jobs, honored only where the deployment allows request overrides.
  #[serde(default, rename = "__firePdfAsync")]
  pub fire_pdf_async: bool,
}

enum Eligibility {
  Eligible,
  IneligibleType(PdfType),
  IneligibleConfidence(f32),
  IneligibleComplexity,
  IneligibleEmptyMarkdown,
}

impl Eligibility {
  fn new(res: &PdfProcessResult) -> Self {
    if res.pdf_type != PdfType::TextBased {
      Self::IneligibleType(res.pdf_type)
    } else if res.confidence < 0.95 {
      Self::IneligibleConfidence(res.confidence)
    } else if res.layout.is_complex {
      Self::IneligibleComplexity
    } else if let Some(markdown) = res.markdown.as_ref() {
      if markdown.is_empty() {
        Self::IneligibleEmptyMarkdown
      } else {
        Self::Eligible
      }
    } else {
      Self::IneligibleEmptyMarkdown
    }
  }

  fn is_eligible(&self) -> bool {
    matches!(self, Eligibility::Eligible)
  }
}

impl Display for Eligibility {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      Eligibility::Eligible => f.write_str("<eligible>"),
      Eligibility::IneligibleType(typ) => write!(f, "pdfType={typ:?}"),
      Eligibility::IneligibleConfidence(conf) => write!(f, "confidence={conf}"),
      Eligibility::IneligibleComplexity => f.write_str("complex layout (tables/columns)"),
      Eligibility::IneligibleEmptyMarkdown => {
        f.write_str("empty markdown (unexpected for TextBased)")
      }
    }
  }
}

fn pdf_content_type_match(content_type: &str) -> bool {
  let normalized = content_type.to_lowercase();

  normalized == "application/pdf" || normalized.starts_with("application/pdf;")
}

fn pdf_binary_match(bytes: &Bytes) -> bool {
  bytes[..usize::min(bytes.len(), 1024)]
    .windows(4)
    .any(|w| w == b"%PDF")
}

fn pdf_base64_match(base64: &str) -> bool {
  base64.starts_with("JVBERi")
}

fn pdf_file_extension_match(filename: &str) -> bool {
  filename.ends_with(".pdf")
}

pub fn has_pdf_signal(result: &RawPageResult) -> bool {
  let is_pdf_content_type = pdf_content_type_match(&result.content_type);

  let is_pdf_binary = match &result.content {
    RawPageContent::Bytes(bytes) => pdf_binary_match(bytes),
    // fire-engine only hands off verified PDFs.
    RawPageContent::BytesOffloaded(_) => true,
    _ => false,
  };

  let is_pdf_file_extension = result
    .filename
    .as_ref()
    .map(|x| pdf_file_extension_match(x))
    .unwrap_or(false);

  is_pdf_content_type || is_pdf_binary || is_pdf_file_extension
}

fn escape_html(text: &str) -> String {
  text
    .replace('&', "&amp;")
    .replace('<', "&lt;")
    .replace('>', "&gt;")
    .replace('"', "&quot;")
    .replace('\'', "&#39;")
}

/// GFM to HTML off the async workers, falling back to an escaped `<pre>` block.
async fn markdown_to_html(markdown: &str) -> String {
  let owned = markdown.to_string();
  tokio::task::spawn_blocking(move || {
    markdown::to_html_with_options(&owned, &markdown::Options::gfm()).ok()
  })
  .await
  .ok()
  .flatten()
  .unwrap_or_else(|| {
    tracing::warn!(
      markdown_length = markdown.len(),
      "markdown to HTML failed, falling back to <pre> wrapper"
    );
    format!("<pre>{}</pre>", escape_html(markdown))
  })
}

/// Bounds concurrent pdf-inspector runs (`PDF_EXTRACTION_CONCURRENCY`, default 3);
/// each holds a whole document in memory. Waiters are served first come, first served.
static PDF_EXTRACTION_PERMITS: LazyLock<Arc<Semaphore>> = LazyLock::new(|| {
  let permits = std::env::var("PDF_EXTRACTION_CONCURRENCY")
    .ok()
    .and_then(|x| x.trim().parse::<usize>().ok())
    .filter(|x| *x > 0)
    .unwrap_or(3);
  Arc::new(Semaphore::new(permits))
});

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InspectPass {
  /// Page count, type and title only.
  Detect,
  /// Full extraction to markdown, capped to the first `max_pages` pages.
  Extract { max_pages: Option<u32> },
}

/// Runs pdf-inspector on the blocking pool, holding an extraction permit until it finishes.
async fn inspect_pdf(bytes: &Bytes, pass: InspectPass) -> Result<PdfProcessResult, String> {
  let permit = Arc::clone(&PDF_EXTRACTION_PERMITS)
    .acquire_owned()
    .await
    .map_err(|e| e.to_string())?;
  let bytes = bytes.clone();
  tokio::task::spawn_blocking(move || {
    let _permit = permit;
    let options = match pass {
      InspectPass::Detect => pdf_inspector::PdfOptions::detect_only(),
      InspectPass::Extract { max_pages: Some(n) } if n > 0 => {
        pdf_inspector::PdfOptions::new().pages(1..=n)
      }
      InspectPass::Extract { .. } => pdf_inspector::PdfOptions::new(),
    };
    pdf_inspector::process_pdf_mem_with_options(&bytes, options).map_err(|e| e.to_string())
  })
  .await
  .map_err(|e| e.to_string())?
}

/// The size fire-engine may hand a PDF off by GCS reference up to (`pdfMaxSize`),
/// granted only when the by-reference route can take it.
pub fn fire_engine_pdf_max_size(meta: &Meta) -> Option<usize> {
  handoff_max_size(FirePdfConfig::get(), meta)
}

fn handoff_max_size(config: &FirePdfConfig, meta: &Meta) -> Option<usize> {
  config.fire_engine_pdf_gcs_bucket.as_ref()?;
  let parser = meta.options.parsers.pdf();
  let force_requested =
    meta.options.__force_fire_pdf || parser.is_some_and(|x| x.pages || x.blocks || x.page_markers);
  by_reference_reachable(
    config,
    parser.is_some_and(|x| x.mode == PdfMode::Fast),
    force_requested,
    meta.internal_options.zero_data_retention,
  )
  .then(|| meta.file_size_limit())
}

fn base64_with_cache_keys(bytes: &[u8], with_cache_keys: bool) -> (String, Option<Vec<String>>) {
  let pdf_b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
  let keys = with_cache_keys.then(|| {
    vec![
      format!("raw-{}", sha256_hex(bytes)),
      sha256_hex(pdf_b64.as_bytes()),
    ]
  });
  (pdf_b64, keys)
}

/// FirePDF over inline base64: the content cache, then async jobs or sync `/ocr`.
async fn fire_pdf_inline<I: FirePdfIo>(
  client: &FirePdfClient<'_, I>,
  bytes: &Bytes,
  options: &FirePdfJobOptions,
  request_opt_in: bool,
  span: &Span,
) -> Result<FirePdfResult, FirePdfError> {
  let request = client.request;
  let with_cache_keys = client.cache_applicable(options);
  let (pdf_b64, cache_keys) = {
    let bytes = bytes.clone();
    tokio::task::spawn_blocking(move || base64_with_cache_keys(&bytes, with_cache_keys)).await
  }
  .unwrap_or_else(|_| base64_with_cache_keys(bytes, with_cache_keys));

  let remaining_ms = request.remaining_ms(client.io.now_ms());
  let (use_async, reason) = decide_async_route(
    client.config,
    &AsyncRouteInput {
      scrape_id: &request.scrape_id,
      team_id: &request.team_id,
      zdr: request.zdr,
      remaining_ms,
      request_opt_in,
      bulk_origin: request.crawl_id.is_some(),
    },
  );
  RouteRecord {
    path: if use_async { "async" } else { "sync" },
    reason: reason.as_str(),
    features: &features_label(options.page_markdown, options.blocks, options.page_markers),
    remaining_ms,
    zdr: request.zdr,
  }
  .record(span);

  if let Some(keys) = cache_keys
    && let Some(cached) = client.lookup_cache(&keys, options).await
  {
    return Ok(cached);
  }

  if !use_async {
    return client.ocr_sync(&pdf_b64, options).await;
  }
  match client
    .run_async(AsyncInput::Inline(&pdf_b64), options)
    .await
  {
    Err(error) if options.page_markdown || options.blocks || options.page_markers => {
      tracing::warn!(
        error = %error,
        "FirePDF async page markdown/blocks/markers failed -- retrying synchronously"
      );
      client.ocr_sync(&pdf_b64, options).await
    }
    result => result,
  }
}

struct Parsed {
  markdown: String,
  html: String,
  pages: Option<Vec<WirePage>>,
  blocks: Option<Vec<WirePageBlocks>>,
}

impl From<FirePdfResult> for Parsed {
  fn from(result: FirePdfResult) -> Self {
    Self {
      markdown: result.markdown,
      html: result.html,
      pages: result.page_markdown,
      blocks: result.blocks,
    }
  }
}

/// Parses a PDF: pdf-inspector serves the text PDFs it handles confidently, FirePDF
/// handles the rest, and text extraction is the last resort. `deadline` is the
/// scrape deadline; it sizes fire-pdf's budgets and the insufficient-time check.
#[tracing::instrument(
  name = "parsers::pdf::parse_pdf",
  skip_all,
  fields(
    pdf.file_size_bytes = Empty,
    pdf.type = Empty,
    pdf.page_count = Empty,
    pdf.eligible = Empty,
    pdf.ineligible_reason = Empty,
    pdf.engine = Empty,
    fire_pdf.route.path = Empty,
    fire_pdf.route.reason = Empty,
    fire_pdf.route.features = Empty,
    fire_pdf.route.remaining_ms = Empty,
  ),
  err
)]
pub async fn parse_pdf(
  meta: &Meta,
  result: RawPageResult,
  deadline: Option<Instant>,
) -> Result<Document, ScrapeURLError> {
  let io = RealIo;
  let deadline_ms = deadline.map(|deadline| {
    io.now_ms()
      + i64::try_from(
        deadline
          .saturating_duration_since(Instant::now())
          .as_millis(),
      )
      .unwrap_or(i64::MAX)
  });
  parse_pdf_with(&io, FirePdfConfig::get(), meta, result, deadline_ms).await
}

async fn parse_pdf_with<I: FirePdfIo>(
  io: &I,
  config: &FirePdfConfig,
  meta: &Meta,
  result: RawPageResult,
  deadline_ms: Option<i64>,
) -> Result<Document, ScrapeURLError> {
  let span = Span::current();
  let RawPageResult {
    url,
    status_code,
    content,
    screenshot,
    actions,
    content_type,
    proxy_used,
    timezone,
    ..
  } = result;

  let (bytes, handoff): (Bytes, Option<Handoff>) = match content {
    RawPageContent::Bytes(bytes) => (bytes, None),
    RawPageContent::BytesOffloaded(offloaded) => {
      let max_bytes = handoff_max_size(config, meta).unwrap_or(PDF_DOWNLOAD_MAX_FILE_SIZE);
      let (bytes, handoff) = download_handoff(io, config, &offloaded, max_bytes).await?;
      (bytes, Some(handoff))
    }
    RawPageContent::IndexFakeHTML(html, pdf_metadata) => {
      if pdf_base64_match(&html) && pdf_metadata.is_none() {
        // An undecoded PDF got dumped into the index. Simply run it through our pipeline.
        (
          base64::engine::general_purpose::STANDARD
            .decode(&html)?
            .into(),
          None,
        )
      } else {
        // This PDF got decoded and the decoded version got saved to the index.
        // Let's serve it as a done document.
        return Ok(Document {
          markdown: None,
          raw_base64: Some(base64::engine::general_purpose::STANDARD.encode(&html)), // TODO: THIS IS FAKE RAW
          raw_html: Some(html),
          html: None,
          links: None,
          images: None,
          screenshot,
          audio: None,
          video: None,
          json: None,
          summary: None,
          answer: None,
          highlights: None,
          attributes: None,
          actions,
          pages: None,
          blocks: None,
          warning: None,
          metadata: DocumentMetadata {
            scrape_id: meta.id.clone(),
            source_url: meta.source_url(),
            url,
            status_code,
            content_type,
            timezone,
            proxy_used,
            cache_state: DocumentMetadataCacheState::Miss,
            cached_at: None,
            index_id: None,
            credits_used: None,
            concurrency_limited: false,
            concurrency_queue_duration_ms: None,
            num_pages: pdf_metadata.as_ref().map(|x| x.num_pages),
            total_pages: pdf_metadata.as_ref().and_then(|x| x.total_pages),
            title: pdf_metadata.and_then(|x| x.title),
            extra: Default::default(),
          },
        });
      }
    }
    RawPageContent::ChromeRenderedDOM(_) | RawPageContent::GeneratedMarkdown(_) => {
      return Err(ScrapeURLError::PDFFetchFailed);
    }
  };
  span.record("pdf.file_size_bytes", bytes.len());

  let metadata =
    |num_pages: Option<u32>, total_pages: Option<u32>, title: Option<String>| DocumentMetadata {
      scrape_id: meta.id.clone(),
      source_url: meta.source_url(),
      url: url.clone(),
      status_code,
      content_type: "application/pdf".to_string(),
      timezone: timezone.clone(),
      proxy_used,
      cache_state: DocumentMetadataCacheState::Miss,
      cached_at: None,
      index_id: None,
      credits_used: None,
      concurrency_limited: false,
      concurrency_queue_duration_ms: None,
      title,
      num_pages,
      total_pages,
      extra: Default::default(),
    };

  let Some(parser) = meta.options.parsers.pdf() else {
    // The raw file goes back base64'd inline, so it keeps the historical cap.
    if bytes.len() > PDF_DOWNLOAD_MAX_FILE_SIZE {
      return Err(ScrapeURLError::UnsupportedFileError {
        reason: "File exceeds size limit".to_string(),
      });
    }
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    return Ok(Document {
      markdown: Some(encoded.clone()),
      raw_html: Some(encoded.clone()),
      raw_base64: Some(encoded.clone()),
      html: Some(encoded),
      links: None,
      images: None,
      screenshot,
      audio: None,
      video: None,
      json: None,
      summary: None,
      answer: None,
      highlights: None,
      attributes: None,
      actions,
      pages: None,
      blocks: None,
      warning: None,
      metadata: metadata(None, None, None),
    });
  };

  let fire_pdf_configured = config.base_url.is_some();
  for (requested, message) in [
    (
      parser.pages,
      "Physical page markdown is unavailable because FirePDF is not configured",
    ),
    (
      parser.blocks,
      "Typed blocks are unavailable because FirePDF is not configured",
    ),
    (
      parser.page_markers,
      "Page markers are unavailable because FirePDF is not configured",
    ),
  ] {
    if requested && !fire_pdf_configured {
      return Err(FirePdfError::Contract(message).into());
    }
  }

  if !pdf_binary_match(&bytes) {
    return Err(ScrapeURLError::PDFFetchFailed);
  }

  let force_requested =
    meta.options.__force_fire_pdf || parser.pages || parser.blocks || parser.page_markers;
  let force_fire_pdf = force_requested && fire_pdf_configured;
  let zdr = meta.internal_options.zero_data_retention;
  let by_reference_ok =
    by_reference_reachable(config, parser.mode == PdfMode::Fast, force_requested, zdr);

  // OCR mode and forced FirePDF only need the page count and title from the local pass.
  let local_pass = if parser.mode == PdfMode::Ocr || force_fire_pdf {
    InspectPass::Detect
  } else {
    InspectPass::Extract {
      max_pages: parser.max_pages,
    }
  };
  let mut effective_page_count: u32 = 0;
  let mut total_page_count: Option<u32> = None;
  let mut title: Option<String> = None;
  let mut parsed: Option<Parsed> = None;
  let mut local_markdown: Option<String> = None;

  match inspect_pdf(&bytes, local_pass).await {
    Ok(inspected) => {
      span.record("pdf.type", format!("{:?}", inspected.pdf_type).as_str());
      span.record("pdf.page_count", inspected.page_count);
      total_page_count = Some(inspected.page_count);
      effective_page_count = match parser.max_pages {
        Some(n) if n > 0 => inspected.page_count.min(n),
        _ => inspected.page_count,
      };
      title = inspected.title.clone();

      if local_pass != InspectPass::Detect {
        let eligibility = Eligibility::new(&inspected);
        span.record("pdf.eligible", eligibility.is_eligible());
        if !eligibility.is_eligible() {
          span.record("pdf.ineligible_reason", eligibility.to_string().as_str());
        }

        // Fast mode fails with a clear error instead of returning empty content.
        if parser.mode == PdfMode::Fast
          && (inspected.pdf_type == PdfType::Scanned || inspected.pdf_type == PdfType::ImageBased)
        {
          return Err(ScrapeURLError::PDFOCRRequiredError(inspected.pdf_type));
        }

        if eligibility.is_eligible()
          && let Some(markdown) = inspected.markdown
        {
          span.record("pdf.engine", "pdf-inspector");
          parsed = Some(Parsed {
            html: markdown_to_html(&markdown).await,
            markdown,
            pages: None,
            blocks: None,
          });
        } else {
          local_markdown = inspected.markdown;
        }
      }
    }
    Err(error) => tracing::warn!(
      error,
      "pdf-inspector failed, continuing without a page count"
    ),
  }

  // Local extraction is fast enough that only OCR is held to the per-page budget.
  if parsed.is_none()
    && effective_page_count > 0
    && let Some(deadline_ms) = deadline_ms
  {
    let needed = u64::from(effective_page_count) * MILLISECONDS_PER_PAGE;
    if i64::try_from(needed).unwrap_or(i64::MAX) > deadline_ms - io.now_ms() {
      return Err(ScrapeURLError::PDFInsufficientTimeError {
        page_count: effective_page_count,
        min_timeout: needed + 5000,
      });
    }
  }

  let skip_ocr = parser.mode == PdfMode::Fast && !force_fire_pdf;
  let fire_pdf_enabled = force_fire_pdf || config.enable;
  let request = FirePdfRequest::from_meta(meta, deadline_ms);
  if parsed.is_none()
    && !skip_ocr
    && fire_pdf_enabled
    && let Some(client) = FirePdfClient::new(io, config, &request)
  {
    let size = bytes.len();
    let limit_bytes = meta.file_size_limit();
    let options = FirePdfJobOptions {
      max_pages: parser.max_pages,
      pages_estimate: effective_page_count,
      mode: parser.mode.clone(),
      page_markdown: parser.pages,
      blocks: parser.blocks,
      page_markers: parser.page_markers,
      refresh: parser.refresh,
    };
    let features = features_label(parser.pages, parser.blocks, parser.page_markers);
    let mut fire_pdf_result: Option<FirePdfResult> = None;

    // Large PDFs cannot travel inline (fire-pdf's body limit, memory), so they go by GCS reference.
    if by_reference_ok && size >= FIRE_PDF_MAX_FILE_SIZE && size <= limit_bytes {
      if effective_page_count == 0 {
        tracing::warn!(
          file_size_bytes = size,
          "Large PDF has no page-count estimate; cannot submit by reference"
        );
      } else {
        let route = RouteRecord {
          path: "async",
          reason: "by_reference",
          features: &features,
          remaining_ms: request.remaining_ms(io.now_ms()),
          zdr,
        };
        let attempt = client
          .by_reference_attempt(ByReferenceAttempt {
            bytes: &bytes,
            handoff: handoff.as_ref(),
            options: &options,
            limit_bytes,
          })
          .await;
        match attempt {
          Ok(Some(result)) => {
            route.record(&span);
            fire_pdf_result = Some(result);
          }
          Ok(None) => {}
          Err(error) => {
            route.record(&span);
            return Err(error.into());
          }
        }
      }
    }

    if fire_pdf_result.is_none() {
      let inline_usable = size < FIRE_PDF_MAX_FILE_SIZE
        || (force_fire_pdf && size <= FIRE_PDF_INLINE_HARD_MAX_FILE_SIZE);
      if force_fire_pdf && !inline_usable {
        return Err(FirePdfError::InlineCeiling(size).into());
      }
      if !force_fire_pdf && size >= FIRE_PDF_MAX_FILE_SIZE {
        tracing::warn!(
          file_size_bytes = size,
          max_size_bytes = FIRE_PDF_MAX_FILE_SIZE,
          "PDF skipped by Fire PDF: exceeds size cap"
        );
      }
      if inline_usable {
        match fire_pdf_inline(&client, &bytes, &options, parser.fire_pdf_async, &span).await {
          Ok(result) => fire_pdf_result = Some(result),
          Err(error) if force_fire_pdf => {
            tracing::error!(error = %error, "FirePDF failed (forced, no fallback)");
            return Err(error.into());
          }
          Err(error) => tracing::warn!(
            error = %error,
            "FirePDF failed -- falling back to text extraction"
          ),
        }
      }
    }

    if let Some(result) = fire_pdf_result {
      span.record("pdf.engine", "fire-pdf");
      // Never shrink a count the local pass established; fire-pdf may have been capped.
      effective_page_count = effective_page_count.max(result.pages_processed);
      parsed = Some(result.into());
    }
  }

  let parsed = match parsed {
    Some(parsed) => parsed,
    None => {
      // Text-only extraction is the last resort, as main's pdf-parse pass; forced FirePDF has none.
      let markdown = if force_fire_pdf {
        String::new()
      } else if local_pass == InspectPass::Detect {
        inspect_pdf(
          &bytes,
          InspectPass::Extract {
            max_pages: parser.max_pages,
          },
        )
        .await
        .ok()
        .and_then(|x| x.markdown)
        .unwrap_or_default()
      } else {
        local_markdown.unwrap_or_default()
      };
      span.record("pdf.engine", "text-fallback");
      Parsed {
        html: markdown_to_html(&markdown).await,
        markdown,
        pages: None,
        blocks: None,
      }
    }
  };

  Ok(Document {
    markdown: Some(parsed.markdown),
    raw_html: Some(parsed.html),
    // A handed-off file can be up to 256MB; fire-engine never grants the handoff to raw requests.
    raw_base64: handoff
      .is_none()
      .then(|| base64::engine::general_purpose::STANDARD.encode(&bytes)),
    html: None,
    links: None,
    images: None,
    screenshot: None,
    audio: None,
    video: None,
    json: None,
    summary: None,
    answer: None,
    highlights: None,
    attributes: None,
    actions,
    warning: None,
    pages: parsed
      .pages
      .filter(|_| parser.pages)
      .map(|pages| pages.into_iter().map(PdfPage::from).collect()),
    blocks: parsed
      .blocks
      .filter(|_| parser.blocks)
      .map(|blocks| blocks.into_iter().map(PdfPageBlocks::from).collect()),
    metadata: metadata(Some(effective_page_count), total_page_count, title),
  })
}

#[cfg(test)]
mod tests {
  use std::sync::atomic::AtomicI64;

  use serde_json::json;
  use url::Url;

  use super::super::super::{
    options::{InternalOptions, ScrapeOptions},
    raw_page::ScrapeProxy,
  };
  use super::firepdf::testing::{FakeIo, RecordedCall, Reply, T0, test_config};
  use super::*;

  /// A one-page, single-column text PDF.
  fn tiny_pdf(text: &str) -> Bytes {
    let filler = (0..30)
      .map(|i| {
        format!("0 -16 Td (Line {i} of ordinary body text in a plain single column document.) Tj")
      })
      .collect::<Vec<_>>()
      .join(" ");
    let content = format!("BT /F1 11 Tf 72 740 Td ({text}) Tj {filler} ET");
    let objects = [
      "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>".to_string(),
      format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len()),
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
    ];
    let mut out = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    for (i, object) in objects.iter().enumerate() {
      offsets.push(out.len());
      out.extend(format!("{} 0 obj\n{object}\nendobj\n", i + 1).bytes());
    }
    let xref = out.len();
    out.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).bytes());
    for offset in offsets {
      out.extend(format!("{offset:010} 00000 n \n").bytes());
    }
    out.extend(
      format!(
        "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
        objects.len() + 1
      )
      .bytes(),
    );
    out.into()
  }

  fn meta_with(parsers: serde_json::Value) -> Meta {
    let mut options = ScrapeOptions::default();
    options.parsers = serde_json::from_value(parsers).unwrap();
    Meta::new(
      "scrape-1".to_string(),
      Url::parse("https://example.com/doc.pdf").unwrap(),
      "team-x".to_string(),
      options,
      InternalOptions::default(),
    )
  }

  fn page(content: RawPageContent) -> RawPageResult {
    RawPageResult {
      url: Url::parse("https://example.com/doc.pdf").unwrap(),
      status_code: 200,
      content,
      screenshot: None,
      actions: None,
      cached_at: None,
      content_type: "application/octet-stream".to_string(),
      proxy_used: ScrapeProxy::Basic,
      timezone: None,
      filename: None,
    }
  }

  fn ocr_reply() -> Reply {
    Reply::json(
      200,
      json!({
        "markdown": "# From FirePDF", "failed_pages": null, "pages_processed": 1,
        "pages": [{"page": 1, "markdown": "# From FirePDF"}]
      }),
    )
  }

  fn urls(io: &FakeIo) -> Vec<String> {
    io.urls()
  }

  #[tokio::test]
  async fn eligible_text_pdfs_are_served_locally() {
    let io = FakeIo::new(vec![]);
    let meta = meta_with(json!(["pdf"]));
    let document = parse_pdf_with(
      &io,
      &test_config(),
      &meta,
      page(RawPageContent::Bytes(tiny_pdf("Hello local world"))),
      None,
    )
    .await
    .unwrap();
    assert!(document.markdown.unwrap().contains("Hello local world"));
    assert!(urls(&io).is_empty());
    assert_eq!(document.metadata.num_pages, Some(1));
    assert_eq!(document.metadata.total_pages, Some(1));
    assert_eq!(document.metadata.content_type, "application/pdf");
    assert!(document.raw_base64.is_some());
  }

  #[tokio::test]
  async fn page_markdown_forces_fire_pdf_and_reaches_the_document() {
    let io = FakeIo::new(vec![ocr_reply()]);
    let meta = meta_with(json!([{"type": "pdf", "pages": true}]));
    let document = parse_pdf_with(
      &io,
      &test_config(),
      &meta,
      page(RawPageContent::Bytes(tiny_pdf("Hello"))),
      None,
    )
    .await
    .unwrap();
    assert_eq!(document.markdown.as_deref(), Some("# From FirePDF"));
    let value = serde_json::to_value(&document).unwrap();
    assert_eq!(
      value["pages"],
      json!([{"pageNumber": 1, "markdown": "# From FirePDF"}])
    );
    assert_eq!(urls(&io), vec!["http://fire-pdf.test/ocr".to_string()]);
    let body = io.calls()[0].body.clone().unwrap();
    assert_eq!(body["include_page_markdown"], true);
    assert_eq!(body["scrape_id"], "scrape-1");
  }

  #[tokio::test]
  async fn page_aware_options_need_fire_pdf() {
    let io = FakeIo::new(vec![]);
    let mut config = test_config();
    config.base_url = None;
    for (parser, message) in [
      (
        json!({"type": "pdf", "pages": true}),
        "Physical page markdown",
      ),
      (json!({"type": "pdf", "blocks": true}), "Typed blocks"),
      (json!({"type": "pdf", "pageMarkers": true}), "Page markers"),
    ] {
      let meta = meta_with(json!([parser]));
      let error = parse_pdf_with(
        &io,
        &config,
        &meta,
        page(RawPageContent::Bytes(tiny_pdf("x"))),
        None,
      )
      .await
      .unwrap_err();
      assert!(error.to_string().starts_with(message), "{error}");
    }
  }

  #[tokio::test]
  async fn a_non_forced_fire_pdf_failure_falls_back_to_text_extraction() {
    let io = FakeIo::new(vec![Reply::json(500, json!({}))]);
    let meta = meta_with(json!([{"type": "pdf", "mode": "ocr"}]));
    let document = parse_pdf_with(
      &io,
      &test_config(),
      &meta,
      page(RawPageContent::Bytes(tiny_pdf("Fallback text"))),
      None,
    )
    .await
    .unwrap();
    assert!(document.markdown.unwrap().contains("Fallback text"));
    assert_eq!(urls(&io), vec!["http://fire-pdf.test/ocr".to_string()]);
  }

  #[tokio::test]
  async fn fire_pdf_enable_gates_requests_that_do_not_force_it() {
    let io = FakeIo::new(vec![ocr_reply()]);
    let mut config = test_config();
    config.enable = false;
    let ocr = meta_with(json!([{"type": "pdf", "mode": "ocr"}]));
    let document = parse_pdf_with(
      &io,
      &config,
      &ocr,
      page(RawPageContent::Bytes(tiny_pdf("Local only"))),
      None,
    )
    .await
    .unwrap();
    assert!(document.markdown.unwrap().contains("Local only"));
    assert!(urls(&io).is_empty());

    let forced = meta_with(json!([{"type": "pdf", "pages": true}]));
    parse_pdf_with(
      &io,
      &config,
      &forced,
      page(RawPageContent::Bytes(tiny_pdf("x"))),
      None,
    )
    .await
    .unwrap();
    assert_eq!(urls(&io), vec!["http://fire-pdf.test/ocr".to_string()]);
  }

  #[tokio::test]
  async fn a_forced_fire_pdf_failure_is_an_error() {
    let io = FakeIo::new(vec![Reply::json(500, json!({}))]);
    let meta = meta_with(json!([{"type": "pdf", "pageMarkers": true}]));
    let error = parse_pdf_with(
      &io,
      &test_config(),
      &meta,
      page(RawPageContent::Bytes(tiny_pdf("x"))),
      None,
    )
    .await
    .unwrap_err();
    assert!(matches!(
      error,
      ScrapeURLError::FirePDF(FirePdfError::Status(500))
    ));
  }

  #[tokio::test]
  async fn ocr_needs_time_for_every_page() {
    let io = FakeIo::new(vec![]);
    let meta = meta_with(json!([{"type": "pdf", "mode": "ocr"}]));
    let error = parse_pdf_with(
      &io,
      &test_config(),
      &meta,
      page(RawPageContent::Bytes(tiny_pdf("x"))),
      Some(T0 + 100),
    )
    .await
    .unwrap_err();
    assert!(matches!(
      error,
      ScrapeURLError::PDFInsufficientTimeError {
        page_count: 1,
        min_timeout: 5_150
      }
    ));
    assert_eq!(error.code(), "SCRAPE_PDF_INSUFFICIENT_TIME_ERROR");
    assert_eq!(
      serde_json::to_value(&error).unwrap(),
      json!({"pageCount": 1, "minTimeout": 5_150})
    );
    assert!(urls(&io).is_empty());
  }

  #[tokio::test]
  async fn the_deadline_reaches_fire_pdf() {
    let io = FakeIo::new(vec![ocr_reply()]);
    let meta = meta_with(json!([{"type": "pdf", "mode": "ocr"}]));
    parse_pdf_with(
      &io,
      &test_config(),
      &meta,
      page(RawPageContent::Bytes(tiny_pdf("x"))),
      Some(T0 + 45_000),
    )
    .await
    .unwrap();
    assert_eq!(io.calls()[0].body.clone().unwrap()["timeout"], 45_000);
  }

  #[tokio::test]
  async fn the_async_cohort_takes_the_jobs_api() {
    let io = FakeIo::with_responder(|call: &RecordedCall, _: &AtomicI64| {
      if call.url.ends_with("/jobs") {
        Reply::json(202, json!({"scrape_id": "scrape-1", "status": "queued"}))
      } else if call.url.ends_with("/result") {
        Reply::json(200, json!({"markdown": "# async"}))
      } else {
        Reply::json(200, json!({"scrape_id": "scrape-1", "status": "done"}))
      }
    });
    let mut config = test_config();
    config.async_force_team_ids.insert("team-x".to_string());
    let meta = meta_with(json!([{"type": "pdf", "mode": "ocr"}]));
    let document = parse_pdf_with(
      &io,
      &config,
      &meta,
      page(RawPageContent::Bytes(tiny_pdf("x"))),
      Some(T0 + 60_000),
    )
    .await
    .unwrap();
    assert_eq!(document.markdown.as_deref(), Some("# async"));
    assert_eq!(io.urls()[0], "http://fire-pdf.test/jobs");
    assert_eq!(
      io.calls()[0].body.clone().unwrap()["options"]["pages_estimate"],
      1
    );
  }

  #[tokio::test]
  async fn page_aware_async_failures_retry_synchronously() {
    let io = FakeIo::new(vec![Reply::json(500, json!({})), ocr_reply()]);
    let mut config = test_config();
    config.async_force_team_ids.insert("team-x".to_string());
    let meta = meta_with(json!([{"type": "pdf", "pages": true}]));
    let document = parse_pdf_with(
      &io,
      &config,
      &meta,
      page(RawPageContent::Bytes(tiny_pdf("x"))),
      None,
    )
    .await
    .unwrap();
    assert_eq!(document.markdown.as_deref(), Some("# From FirePDF"));
    assert_eq!(
      urls(&io),
      vec![
        "http://fire-pdf.test/jobs".to_string(),
        "http://fire-pdf.test/ocr".to_string()
      ]
    );
  }

  #[tokio::test]
  async fn fast_mode_never_reaches_fire_pdf() {
    let io = FakeIo::new(vec![]);
    let meta = meta_with(json!([{"type": "pdf", "mode": "fast"}]));
    let config = test_config();
    let mut minimal = b"%PDF-1.4\n".to_vec();
    minimal.extend_from_slice(b"not really a pdf");
    let document = parse_pdf_with(
      &io,
      &config,
      &meta,
      page(RawPageContent::Bytes(minimal.into())),
      None,
    )
    .await
    .unwrap();
    assert_eq!(document.markdown.as_deref(), Some(""));
    assert!(urls(&io).is_empty());
  }

  #[tokio::test]
  async fn unparsed_pdfs_come_back_raw() {
    let io = FakeIo::new(vec![]);
    let meta = meta_with(json!([]));
    let bytes = tiny_pdf("x");
    let document = parse_pdf_with(
      &io,
      &test_config(),
      &meta,
      page(RawPageContent::Bytes(bytes.clone())),
      None,
    )
    .await
    .unwrap();
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    assert_eq!(document.markdown.as_deref(), Some(encoded.as_str()));
    assert_eq!(document.metadata.content_type, "application/pdf");
  }

  #[tokio::test]
  async fn non_pdf_content_is_a_fetch_failure() {
    let io = FakeIo::new(vec![]);
    let meta = meta_with(json!(["pdf"]));
    for content in [
      RawPageContent::ChromeRenderedDOM("<html></html>".to_string()),
      RawPageContent::Bytes(Bytes::from_static(b"<html>not a pdf</html>")),
    ] {
      assert!(matches!(
        parse_pdf_with(&io, &test_config(), &meta, page(content), None).await,
        Err(ScrapeURLError::PDFFetchFailed)
      ));
    }
  }

  #[tokio::test]
  async fn a_garbled_indexed_pdf_is_an_error_not_a_panic() {
    let io = FakeIo::new(vec![]);
    let meta = meta_with(json!(["pdf"]));
    let result = parse_pdf_with(
      &io,
      &test_config(),
      &meta,
      page(RawPageContent::IndexFakeHTML(
        "JVBERi*not base64*".to_string(),
        None,
      )),
      None,
    )
    .await;
    assert!(matches!(result, Err(ScrapeURLError::Base64(_))));
  }

  #[tokio::test]
  async fn handed_off_pdfs_are_downloaded_and_parsed() {
    let mut io = FakeIo::new(vec![]);
    io.stored_object = Some(tiny_pdf("Handed off"));
    let meta = meta_with(json!(["pdf"]));
    let document = parse_pdf_with(
      &io,
      &test_config(),
      &meta,
      page(RawPageContent::BytesOffloaded(
        super::super::super::raw_page::BytesOffloaded {
          gcs_uri: "gs://fe-handoff/big.pdf".to_string(),
          sha256: None,
          size_bytes: None,
        },
      )),
      None,
    )
    .await
    .unwrap();
    assert!(document.markdown.unwrap().contains("Handed off"));
    assert_eq!(document.raw_base64, None);
  }

  #[test]
  fn handoffs_are_pdf_signals() {
    let offloaded = page(RawPageContent::BytesOffloaded(
      super::super::super::raw_page::BytesOffloaded {
        gcs_uri: "gs://fe-handoff/x".to_string(),
        sha256: None,
        size_bytes: None,
      },
    ));
    assert!(has_pdf_signal(&offloaded));
  }

  #[test]
  fn parser_options_accept_refresh_and_the_async_opt_in() {
    let options: PdfOptions =
      serde_json::from_value(json!({"refresh": true, "__firePdfAsync": true, "maxPages": 3}))
        .unwrap();
    assert!(options.refresh);
    assert!(options.fire_pdf_async);
    assert_eq!(options.max_pages, Some(3));
  }

  #[test]
  fn public_blocks_use_the_document_shape() {
    let blocks: Vec<WirePageBlocks> = serde_json::from_value(json!([{
      "page": 2, "width": 612, "height": null, "status": "ok",
      "items": [{
        "id": "b", "type": "table", "label": null, "bbox": [1, 2, 3, 4], "content": "c",
        "markdown_span": [0, 1], "reading_order": 3, "source": "ocr",
        "confidence": {"layout": 0.5, "ocr": null}
      }]
    }]))
    .unwrap();
    let public: Vec<PdfPageBlocks> = blocks.into_iter().map(PdfPageBlocks::from).collect();
    assert_eq!(
      serde_json::to_value(public).unwrap(),
      json!([{
        "pageNumber": 2, "width": 612.0, "height": null, "status": "ok",
        "items": [{
          "id": "b", "type": "table", "label": null, "bbox": [1.0, 2.0, 3.0, 4.0], "content": "c",
          "markdownSpan": [0.0, 1.0], "readingOrder": 3.0, "source": "ocr",
          "confidence": {"layout": 0.5, "ocr": null}
        }]
      }])
    );
  }
}
