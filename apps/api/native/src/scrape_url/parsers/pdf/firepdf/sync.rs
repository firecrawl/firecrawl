use tracing::{Instrument, field::Empty};

use super::{
  FirePdfClient, FirePdfError, FirePdfJobOptions, FirePdfResult,
  io::{self, Method},
  log_provenance,
  schema::{OcrDocument, OcrRequest, Provenance},
  sha256_hex,
};

impl FirePdfClient<'_> {
  /// The sync `POST /ocr` parse of an inline base64 PDF.
  pub async fn ocr_sync(
    &self,
    pdf_b64: &str,
    options: &FirePdfJobOptions,
  ) -> Result<FirePdfResult, FirePdfError> {
    let span = tracing::info_span!(
      "fire_pdf::ocr",
      fire_pdf.pages_processed = Empty,
      fire_pdf.markdown_length = Empty,
      fire_pdf.failed_pages = Empty,
      fire_pdf.duration_ms = Empty,
      fire_pdf.cache_key = Empty,
      fire_pdf.generation = Empty,
      fire_pdf.build_sha = Empty,
    );
    self
      .ocr_sync_inner(pdf_b64, options, &span)
      .instrument(span.clone())
      .await
  }

  async fn ocr_sync_inner(
    &self,
    pdf_b64: &str,
    options: &FirePdfJobOptions,
    span: &tracing::Span,
  ) -> Result<FirePdfResult, FirePdfError> {
    let request = self.request;
    let started_at = io::now_ms();
    let pdf_sha256 = sha256_hex(pdf_b64.as_bytes());
    span.record("fire_pdf.cache_key", pdf_sha256.as_str());

    // fire-pdf computes its remaining budget as `timeout - (now - created_at)` and answers
    // 503 once it is spent. Without a scrape deadline it applies its own default.
    let (timeout, created_at) = match self.remaining_ms() {
      Some(remaining) if remaining > 0 => (Some(remaining), Some(io::now_ms())),
      _ => (None, None),
    };

    let body = serde_json::to_vec(&OcrRequest {
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
    .map_err(|e| FirePdfError::Schema(e.to_string()))?;

    tracing::info!(
      max_pages = options.max_pages,
      pages_estimate = options.pages_estimate,
      "FirePDF started"
    );

    let response = self
      .send(
        Method::Post,
        format!("{}/ocr", self.base_url),
        Some(body),
        None,
      )
      .await
      .map_err(FirePdfError::Transport)?;
    if response.status >= 300 {
      return Err(FirePdfError::Status(response.status));
    }
    let document: OcrDocument =
      serde_json::from_slice(&response.body).map_err(|e| FirePdfError::Schema(e.to_string()))?;

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
    // Without the echo the markdown is ordinary unmarked output.
    if options.page_markers && document.page_markers != Some(true) {
      return Err(FirePdfError::Contract(
        "FirePDF response did not acknowledge requested page markers",
      ));
    }

    let pages_processed = document.pages_processed.unwrap_or(options.pages_estimate);
    let provenance = Provenance::parse(document.provenance.as_ref());
    log_provenance(&provenance, &pdf_sha256);
    let duration_ms = io::now_ms() - started_at;

    span.record("fire_pdf.pages_processed", pages_processed);
    span.record("fire_pdf.markdown_length", document.markdown.len());
    span.record(
      "fire_pdf.failed_pages",
      document.failed_pages.as_ref().map_or(0, Vec::len),
    );
    span.record("fire_pdf.duration_ms", duration_ms);
    span.record("fire_pdf.generation", provenance.generation());
    span.record("fire_pdf.build_sha", provenance.build_sha());
    tracing::info!(
      duration_ms,
      markdown_length = document.markdown.len(),
      failed_pages = document.failed_pages.as_ref().map_or(0, Vec::len),
      partial_pages = document.partial_pages.as_ref().map_or(0, Vec::len),
      pages_processed,
      per_page_ms = (pages_processed > 0).then(|| duration_ms / i64::from(pages_processed)),
      "FirePDF completed"
    );

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
}
