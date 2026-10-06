//! The FirePDF step: large PDFs by GCS reference, everything else inline.

use bytes::Bytes;
use tracing::{Span, field::Empty};

use super::{
  super::super::{error::ScrapeURLError, meta::Meta},
  firepdf::{
    ByReferenceAttempt, FirePdfClient, FirePdfConfig, FirePdfError, FirePdfJobOptions,
    FirePdfRequest, FirePdfResult, Handoff, RouteRecord, by_reference_reachable, features_label,
    now_ms,
  },
  inline::fire_pdf_inline,
  limits::{FIRE_PDF_INLINE_HARD_MAX_FILE_SIZE, FIRE_PDF_MAX_FILE_SIZE},
  types::{PdfMode, PdfOptions},
};

/// Page-aware options need FirePDF; without it they fail instead of returning plain markdown.
pub fn ensure_configured(config: &FirePdfConfig, parser: &PdfOptions) -> Result<(), FirePdfError> {
  if config.base_url.is_some() {
    return Ok(());
  }
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
    if requested {
      return Err(FirePdfError::Contract(message));
    }
  }
  Ok(())
}

pub struct OcrInput<'a> {
  pub bytes: &'a Bytes,
  pub handoff: Option<&'a Handoff>,
  pub parser: &'a PdfOptions,
  /// `__forceFirePDF` or a page-aware option.
  pub force_requested: bool,
  /// Forced and FirePDF is configured: no fallback to text extraction.
  pub force_fire_pdf: bool,
  pub pages_estimate: u32,
  pub deadline_ms: Option<i64>,
}

/// FirePDF, unless fast mode or the deployment rules it out. `None` means the caller falls back.
pub async fn run_ocr(
  config: &FirePdfConfig,
  meta: &Meta,
  input: OcrInput<'_>,
) -> Result<Option<FirePdfResult>, ScrapeURLError> {
  let skip_ocr = input.parser.mode == PdfMode::Fast && !input.force_fire_pdf;
  if skip_ocr || !(input.force_fire_pdf || config.enable) {
    return Ok(None);
  }
  let request = FirePdfRequest::from_meta(meta, input.deadline_ms);
  let Some(client) = FirePdfClient::new(config, &request) else {
    return Ok(None);
  };
  fire_pdf(&client, meta, input).await
}

#[tracing::instrument(
  name = "parsers::pdf::fire_pdf",
  skip_all,
  fields(
    file_size_bytes = input.bytes.len(),
    fire_pdf.pages_estimate = input.pages_estimate,
    fire_pdf.forced = input.force_fire_pdf,
    fire_pdf.route.path = Empty,
    fire_pdf.route.reason = Empty,
    fire_pdf.route.features = Empty,
    fire_pdf.route.remaining_ms = Empty,
    fire_pdf.by_reference.skipped = Empty,
    fire_pdf.inline.skipped = Empty,
    fire_pdf.fell_back = Empty,
  ),
  err
)]
async fn fire_pdf(
  client: &FirePdfClient<'_>,
  meta: &Meta,
  input: OcrInput<'_>,
) -> Result<Option<FirePdfResult>, ScrapeURLError> {
  let parser = input.parser;
  let options = FirePdfJobOptions {
    max_pages: parser.max_pages,
    pages_estimate: input.pages_estimate,
    mode: parser.mode.clone(),
    page_markdown: parser.pages,
    blocks: parser.blocks,
    page_markers: parser.page_markers,
    refresh: parser.refresh,
  };
  let size = input.bytes.len();
  let limit_bytes = meta.file_size_limit();
  let by_reference_ok = by_reference_reachable(
    client.config,
    parser.mode == PdfMode::Fast,
    input.force_requested,
    client.request.zdr,
  );
  // Large PDFs cannot travel inline (fire-pdf's body limit, memory), so they go by GCS reference.
  if by_reference_ok
    && size >= FIRE_PDF_MAX_FILE_SIZE
    && size <= limit_bytes
    && let Some(result) = by_reference(client, &input, &options, limit_bytes).await?
  {
    return Ok(Some(result));
  }
  inline(client, &input, &options).await
}

async fn by_reference(
  client: &FirePdfClient<'_>,
  input: &OcrInput<'_>,
  options: &FirePdfJobOptions,
  limit_bytes: usize,
) -> Result<Option<FirePdfResult>, ScrapeURLError> {
  let span = Span::current();
  if input.pages_estimate == 0 {
    span.record("fire_pdf.by_reference.skipped", "no_page_estimate");
    return Ok(None);
  }
  let route = RouteRecord {
    path: "async",
    reason: "by_reference",
    features: &features_label(options.page_markdown, options.blocks, options.page_markers),
    remaining_ms: client.request.remaining_ms(now_ms()),
  };
  let attempt = client
    .by_reference_attempt(ByReferenceAttempt {
      bytes: input.bytes,
      handoff: input.handoff,
      options,
      limit_bytes,
    })
    .await;
  // A null attempt never reached the async transport; the inline route records its own decision.
  if !matches!(attempt, Ok(None)) {
    route.record(&span);
  }
  Ok(attempt?)
}

async fn inline(
  client: &FirePdfClient<'_>,
  input: &OcrInput<'_>,
  options: &FirePdfJobOptions,
) -> Result<Option<FirePdfResult>, ScrapeURLError> {
  let span = Span::current();
  let size = input.bytes.len();
  let inline_usable = size < FIRE_PDF_MAX_FILE_SIZE
    || (input.force_fire_pdf && size <= FIRE_PDF_INLINE_HARD_MAX_FILE_SIZE);
  if !inline_usable {
    if input.force_fire_pdf {
      return Err(FirePdfError::InlineCeiling(size).into());
    }
    span.record("fire_pdf.inline.skipped", "size_cap");
    return Ok(None);
  }
  match fire_pdf_inline(
    client,
    input.bytes,
    options,
    input.parser.fire_pdf_async,
    &span,
  )
  .await
  {
    Ok(result) => Ok(Some(result)),
    Err(error) if input.force_fire_pdf => Err(error.into()),
    Err(error) => {
      span.record("fire_pdf.fell_back", true);
      tracing::error!(error = %error, "FirePDF inline failed; falling back");
      Ok(None)
    }
  }
}
