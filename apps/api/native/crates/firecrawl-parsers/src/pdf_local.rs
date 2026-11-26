//! Local PDF inspection and text extraction via `pdf-inspector`.

use std::sync::LazyLock;

use base64::Engine;
use firecrawl_core_types::parsers::MAX_PDF_PAGES;
use firecrawl_core_types::{
  CoreNativeError, CoreParserKind, CorePdfInspection, CorePdfMode, CorePdfParserOptions,
  CorePdfType, ParseRawDocumentResult,
};
use pdf_inspector::{PdfError, PdfOptions, PdfType, process_pdf_mem_with_options};
use tracing::{Dispatch, Span};

use crate::magic::sniff_pdf_bytes;

static PDF_EXTRACTION_CONCURRENCY: LazyLock<usize> = LazyLock::new(|| {
  std::env::var("PDF_EXTRACTION_CONCURRENCY")
    .ok()
    .and_then(|val| val.trim().parse::<usize>().ok())
    .filter(|&val| val > 0)
    .unwrap_or(3)
});

/// Rayon threads per local PDF extraction so concurrent runs stay bounded by
/// available CPU cores.
static PDF_POOL_THREADS: LazyLock<usize> = LazyLock::new(|| {
  let cores = std::thread::available_parallelism().map_or(1, usize::from);
  cores
    .checked_div(*PDF_EXTRACTION_CONCURRENCY)
    .unwrap_or(1)
    .max(1)
});

fn map_pdf_type(pdf_type: PdfType) -> CorePdfType {
  match pdf_type {
    PdfType::TextBased => CorePdfType::TextBased,
    PdfType::Scanned => CorePdfType::Scanned,
    PdfType::ImageBased => CorePdfType::ImageBased,
    PdfType::Mixed => CorePdfType::Mixed,
  }
}

/// Runs `f` on a scoped rayon thread pool whose worker threads inherit the
/// caller's active tracing subscriber dispatch and current span so ZDR
/// suppression and panic withholding remain active across rayon workers.
fn run_on_scoped_pdf_pool<R: Send>(f: impl FnOnce() -> R + Send) -> Result<R, CoreNativeError> {
  let span = Span::current();
  let dispatch = tracing::dispatcher::get_default(Dispatch::clone);
  rayon::ThreadPoolBuilder::new()
    .num_threads(*PDF_POOL_THREADS)
    .build_scoped(
      |thread| {
        tracing::dispatcher::with_default(&dispatch, || {
          let _guard = span.enter();
          thread.run();
        });
      },
      |pool| pool.install(f),
    )
    .map_err(|err| CoreNativeError::Internal {
      message: format!("failed to build PDF worker pool: {err}"),
    })
}

fn map_pdf_error(err: PdfError) -> CoreNativeError {
  match err {
    PdfError::NotAPdf(hint) => CoreNativeError::UnsupportedFile {
      reason: format!("Not a valid PDF: {hint}"),
    },
    PdfError::Encrypted => CoreNativeError::DocumentParse {
      parser: CoreParserKind::Pdf,
      message: "PDF is encrypted".to_string(),
    },
    other => CoreNativeError::DocumentParse {
      parser: CoreParserKind::Pdf,
      message: other.to_string(),
    },
  }
}

/// Inspects and extracts text from raw PDF bytes using `pdf-inspector`.
///
/// Honors `mode` (`fast` rejects `Scanned`/`ImageBased` PDFs with
/// `CoreNativeError::PdfOcrRequired`; `auto` returns complete inspection
/// metadata so callers can fall back to OCR) and `max_pages` (`1..=10000`).
pub(crate) fn parse_pdf_bytes(
  raw_bytes: &[u8],
  options: &CorePdfParserOptions,
  wants_raw_base64: bool,
) -> Result<ParseRawDocumentResult, CoreNativeError> {
  if let Some(pages) = options.max_pages
    && !(1..=MAX_PDF_PAGES).contains(&pages)
  {
    return Err(CoreNativeError::InvalidInput {
      argument: "requestJson".to_string(),
      path: "parsers.pdf.maxPages".to_string(),
      message: format!("maxPages must be between 1 and {MAX_PDF_PAGES}, got {pages}"),
    });
  }

  // Fast-reject non-PDF buffers before building a scoped rayon pool.
  if !sniff_pdf_bytes(raw_bytes) {
    return Err(CoreNativeError::UnsupportedFile {
      reason: "Not a valid PDF: missing %PDF- header".to_string(),
    });
  }

  let pdf_opts = match options.max_pages {
    Some(max_pages) => PdfOptions::new().pages(1..=max_pages),
    None => PdfOptions::new(),
  };

  let inspected = run_on_scoped_pdf_pool(|| process_pdf_mem_with_options(raw_bytes, pdf_opts))?
    .map_err(map_pdf_error)?;

  let pdf_type = map_pdf_type(inspected.pdf_type);
  let mode = options.mode.unwrap_or_default();

  if mode == CorePdfMode::Fast && matches!(pdf_type, CorePdfType::Scanned | CorePdfType::ImageBased)
  {
    return Err(CoreNativeError::PdfOcrRequired { pdf_type });
  }

  let total_pages = inspected.page_count;
  let num_pages = options
    .max_pages
    .map_or(total_pages, |cap| total_pages.min(cap));

  let needs_ocr = matches!(pdf_type, CorePdfType::Scanned | CorePdfType::ImageBased)
    || !inspected.pages_needing_ocr.is_empty()
    || inspected.has_encoding_issues;

  let inspection = CorePdfInspection {
    pdf_type,
    page_count: total_pages,
    confidence: f64::from(inspected.confidence),
    is_complex: inspected.layout.is_complex,
    pages_needing_ocr: inspected.pages_needing_ocr,
    processing_time_ms: inspected.processing_time_ms as f64,
  };

  let warning = needs_ocr.then(|| {
    "PDF contains scanned or image-based content that may require OCR for complete text extraction."
      .to_string()
  });

  let markdown = inspected.markdown.filter(|md| !md.is_empty());
  let title = inspected.title.filter(|t| !t.is_empty());
  let raw_base64 =
    wants_raw_base64.then(|| base64::engine::general_purpose::STANDARD.encode(raw_bytes));

  Ok(ParseRawDocumentResult {
    parser: CoreParserKind::Pdf,
    content_type: "application/pdf".to_string(),
    markdown,
    html: None,
    raw_html: None,
    raw_base64,
    title,
    num_pages: Some(num_pages),
    total_pages: Some(total_pages),
    pdf_inspection: Some(inspection),
    warning,
  })
}
