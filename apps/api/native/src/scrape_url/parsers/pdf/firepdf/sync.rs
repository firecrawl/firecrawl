//! The sync `POST /ocr` endpoint.

use tracing::{Span, field::Empty};

use super::{
  FirePdfClient, FirePdfError, FirePdfJobOptions, FirePdfResult,
  io::{self, Method},
  schema::{OcrDocument, OcrRequest, Provenance},
  sha256_hex,
};

/// Without the echo, marked markdown is indistinguishable from ordinary output.
fn check_requested(
  options: &FirePdfJobOptions,
  document: &OcrDocument,
) -> Result<(), FirePdfError> {
  if options.page_markdown && document.pages.is_none() {
    return Err(FirePdfError::Contract(
      "FirePDF response did not include requested physical page markdown",
    ));
  }
  if options.blocks && document.blocks.is_none() {
    return Err(FirePdfError::Contract(
      "FirePDF response did not include requested typed blocks",
    ));
  }
  if options.page_markers && document.page_markers != Some(true) {
    return Err(FirePdfError::Contract(
      "FirePDF response did not acknowledge requested page markers",
    ));
  }
  Ok(())
}

impl FirePdfClient<'_> {
  /// The sync `POST /ocr` parse of an inline base64 PDF.
  #[tracing::instrument(
    name = "FirePdfClient::ocr_sync",
    skip_all,
    fields(
      fire_pdf.pages_estimate = options.pages_estimate,
      fire_pdf.max_pages = options.max_pages,
      fire_pdf.cache_key = Empty,
      fire_pdf.timeout_ms = Empty,
      http.status = Empty,
      fire_pdf.pages_processed = Empty,
      fire_pdf.markdown_length = Empty,
      fire_pdf.failed_pages = Empty,
      fire_pdf.partial_pages = Empty,
      fire_pdf.duration_ms = Empty,
      fire_pdf.per_page_ms = Empty,
      fire_pdf.provenance = Empty,
      fire_pdf.provenance_issue = Empty,
      fire_pdf.generation = Empty,
      fire_pdf.build_sha = Empty,
    ),
    err
  )]
  pub async fn ocr_sync(
    &self,
    pdf_b64: &str,
    options: &FirePdfJobOptions,
  ) -> Result<FirePdfResult, FirePdfError> {
    let span = Span::current();
    let started_at = io::now_ms();
    let body = self.ocr_body(pdf_b64, options, &span)?;
    let response = self
      .send(
        Method::Post,
        format!("{}/ocr", self.base_url),
        Some(body),
        None,
      )
      .await
      .map_err(FirePdfError::Transport)?;
    span.record("http.status", response.status);
    if response.status >= 300 {
      return Err(FirePdfError::Status(response.status));
    }
    let document: OcrDocument =
      serde_json::from_slice(&response.body).map_err(|e| FirePdfError::Schema(e.to_string()))?;
    check_requested(options, &document)?;

    let pages_processed = document.pages_processed.unwrap_or(options.pages_estimate);
    let duration_ms = io::now_ms() - started_at;
    span.record("fire_pdf.pages_processed", pages_processed);
    span.record("fire_pdf.markdown_length", document.markdown.len());
    span.record(
      "fire_pdf.failed_pages",
      document.failed_pages.as_ref().map_or(0, Vec::len),
    );
    span.record(
      "fire_pdf.partial_pages",
      document.partial_pages.as_ref().map_or(0, Vec::len),
    );
    span.record("fire_pdf.duration_ms", duration_ms);
    span.record(
      "fire_pdf.per_page_ms",
      (pages_processed > 0).then(|| duration_ms / i64::from(pages_processed)),
    );
    Provenance::parse(document.provenance.as_ref()).record(&span);

    Ok(
      FirePdfResult::new(
        document.markdown,
        pages_processed,
        document.pages,
        document.blocks,
      )
      .await,
    )
  }

  /// fire-pdf computes its remaining budget as `timeout - (now - created_at)` and answers
  /// 503 once it is spent. Without a scrape deadline it applies its own default.
  fn ocr_body(
    &self,
    pdf_b64: &str,
    options: &FirePdfJobOptions,
    span: &Span,
  ) -> Result<Vec<u8>, FirePdfError> {
    let request = self.request;
    let pdf_sha256 = sha256_hex(pdf_b64.as_bytes());
    span.record("fire_pdf.cache_key", pdf_sha256.as_str());
    let (timeout, created_at) = match self.remaining_ms() {
      Some(remaining) if remaining > 0 => (Some(remaining), Some(io::now_ms())),
      _ => (None, None),
    };
    span.record("fire_pdf.timeout_ms", timeout);
    serde_json::to_vec(&OcrRequest {
      pdf: pdf_b64,
      scrape_id: &request.scrape_id,
      max_pages: options.max_pages,
      mode: options.mode.clone(),
      include_page_markdown: options.page_markdown,
      include_blocks: options.blocks,
      page_markers: options.page_markers,
      team_id: &request.team_id,
      crawl_id: request.crawl_id.as_deref(),
      metadata: request.metadata(),
      pdf_sha256: &pdf_sha256,
      source: "firecrawl",
      zdr: request.zdr,
      timeout,
      created_at,
    })
    .map_err(|e| FirePdfError::Schema(e.to_string()))
  }
}
