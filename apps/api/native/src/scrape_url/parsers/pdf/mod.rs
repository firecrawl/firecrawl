use tokio::time::Instant;
use tracing::{Span, field::Empty};

use self::{
  detect::{pdf_binary_match, pdf_content_type_match, pdf_file_extension_match},
  firepdf::{FirePdfConfig, now_ms},
  limits::ensure_ocr_time,
  local::{run_local_pass, text_fallback},
  ocr::{OcrInput, ensure_configured, run_ocr},
  output::{PageInfo, PdfFacts, indexed_document, parsed_document, raw_document},
  source::{PdfSource, load_pdf},
};
use super::super::{
  document::Document,
  error::ScrapeURLError,
  meta::Meta,
  raw_page::{RawPageContent, RawPageResult},
};

mod detect;
mod firepdf;
mod html;
mod inline;
mod inspector;
mod limits;
mod local;
mod ocr;
mod output;
mod source;
mod types;

pub use self::{
  firepdf::FirePdfError,
  limits::fire_engine_pdf_max_size,
  types::{PdfOptions, PdfPage, PdfPageBlocks},
};

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

/// The scrape deadline on the epoch-millisecond clock fire-pdf's deadline contract uses.
fn deadline_epoch_ms(deadline: Instant) -> i64 {
  let remaining = deadline
    .saturating_duration_since(Instant::now())
    .as_millis();
  now_ms().saturating_add(i64::try_from(remaining).unwrap_or(i64::MAX))
}

/// Parses a PDF: pdf-inspector serves the text PDFs it handles confidently, FirePDF
/// handles the rest, and text extraction is the last resort. `deadline` is the
/// scrape deadline; it sizes fire-pdf's budgets and the insufficient-time check.
#[tracing::instrument(
  name = "parsers::pdf::parse_pdf",
  skip_all,
  fields(
    pdf.file_size_bytes = Empty,
    pdf.handed_off = Empty,
    pdf.engine = Empty,
    pdf.num_pages = Empty,
    pdf.total_pages = Empty,
  ),
  err
)]
pub async fn parse_pdf(
  meta: &Meta,
  result: RawPageResult,
  deadline: Option<Instant>,
) -> Result<Document, ScrapeURLError> {
  let span = Span::current();
  let config = FirePdfConfig::get();
  let deadline_ms = deadline.map(deadline_epoch_ms);
  let (page, content) = PageInfo::split(result);

  let (bytes, handoff) = match load_pdf(config, meta, content).await? {
    PdfSource::Bytes { bytes, handoff } => (bytes, handoff),
    PdfSource::Indexed { html, pdf_metadata } => {
      span.record("pdf.engine", "index");
      return Ok(indexed_document(meta, page, html, pdf_metadata));
    }
  };
  span.record("pdf.file_size_bytes", bytes.len());
  span.record("pdf.handed_off", handoff.is_some());

  let Some(parser) = meta.options.parsers.pdf() else {
    span.record("pdf.engine", "raw");
    return raw_document(meta, page, &bytes);
  };
  ensure_configured(config, parser)?;
  if !pdf_binary_match(&bytes) {
    return Err(ScrapeURLError::PDFFetchFailed);
  }

  let force_requested = meta.options.__force_fire_pdf || parser.page_aware();
  let force_fire_pdf = force_requested && config.base_url.is_some();
  let mut local = run_local_pass(&bytes, parser, force_fire_pdf).await?;
  let mut engine = "pdf-inspector";

  if local.parsed.is_none() {
    ensure_ocr_time(local.effective_page_count, deadline_ms, now_ms())?;
    let input = OcrInput {
      bytes: &bytes,
      handoff: handoff.as_ref(),
      parser,
      force_requested,
      force_fire_pdf,
      pages_estimate: local.effective_page_count,
      deadline_ms,
    };
    if let Some(result) = run_ocr(config, meta, input).await? {
      engine = "fire-pdf";
      // Never shrink a count the local pass established; fire-pdf may have been capped.
      local.effective_page_count = local.effective_page_count.max(result.pages_processed);
      local.parsed = Some(result.into());
    }
  }

  let facts = PdfFacts {
    num_pages: Some(local.effective_page_count),
    total_pages: local.total_page_count,
    title: local.title.take(),
  };
  let parsed = match local.parsed.take() {
    Some(parsed) => parsed,
    None => {
      engine = "text-fallback";
      text_fallback(&bytes, parser, local, force_fire_pdf).await
    }
  };
  span.record("pdf.engine", engine);
  span.record("pdf.num_pages", facts.num_pages);
  span.record("pdf.total_pages", facts.total_pages);
  let handed_off = handoff.is_some();
  Ok(parsed_document(
    meta, page, parser, parsed, &bytes, handed_off, facts,
  ))
}
