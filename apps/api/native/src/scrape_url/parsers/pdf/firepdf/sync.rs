use tracing::{Instrument, field::Empty};

use super::{
  FirePdfClient, FirePdfError, FirePdfJobOptions, FirePdfResult,
  io::{FirePdfIo, Method},
  log_provenance,
  schema::{OcrDocument, OcrRequest, Provenance},
  sha256_hex,
};

impl<I: FirePdfIo> FirePdfClient<'_, I> {
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
    let started_at = self.io.now_ms();
    let pdf_sha256 = sha256_hex(pdf_b64.as_bytes());
    span.record("fire_pdf.cache_key", pdf_sha256.as_str());

    // fire-pdf computes its remaining budget as `timeout - (now - created_at)` and answers
    // 503 once it is spent. Without a scrape deadline it applies its own default.
    let (timeout, created_at) = match self.remaining_ms() {
      Some(remaining) if remaining > 0 => (Some(remaining), Some(self.io.now_ms())),
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
    let duration_ms = self.io.now_ms() - started_at;

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

#[cfg(test)]
mod tests {
  use serde_json::json;

  use super::super::testing::{FakeIo, Reply, client_for, job_options, test_config, test_request};
  use super::*;

  #[tokio::test]
  async fn sends_request_metadata_and_the_deadline_contract() {
    let io = FakeIo::new(vec![Reply::json(
      200,
      json!({"markdown": "# Hi", "failed_pages": null, "pages_processed": 2}),
    )]);
    let config = test_config();
    let mut request = test_request();
    request.deadline_ms = Some(io.now_ms() + 45_000);
    request.crawl_id = Some("crawl-1".to_string());
    let client = client_for(&io, &config, &request);

    let result = client.ocr_sync("JVBERi0x", &job_options()).await.unwrap();
    assert_eq!(result.markdown, "# Hi");
    assert_eq!(result.pages_processed, 2);
    assert!(result.html.contains("<h1>Hi</h1>"));

    let calls = io.calls();
    assert_eq!(calls[0].url, "http://fire-pdf.test/ocr");
    assert_eq!(calls[0].bearer.as_deref(), Some("secret"));
    let body = calls[0].body.clone().unwrap();
    assert_eq!(body["pdf"], "JVBERi0x");
    assert_eq!(body["scrape_id"], "scrape-id-test");
    assert_eq!(body["team_id"], "team-x");
    assert_eq!(body["crawl_id"], "crawl-1");
    assert_eq!(body["mode"], "auto");
    assert_eq!(body["source"], "firecrawl");
    assert_eq!(body["source_endpoint"], "scrape");
    assert_eq!(body["source_request_context"], "default");
    assert_eq!(body["source_kind"], "pdf");
    assert_eq!(body["url"], "https://example.com/doc.pdf");
    assert_eq!(body["zdr"], false);
    assert_eq!(body["timeout"], 45_000);
    assert_eq!(body["created_at"], io.now_ms());
    assert_eq!(body["pdf_sha256"], sha256_hex(b"JVBERi0x"));
    assert!(body.get("include_page_markdown").is_none());
    assert!(body.get("page_markers").is_none());
    assert!(body.get("max_pages").is_none());
  }

  #[tokio::test]
  async fn zdr_requests_omit_the_url_and_custom_context_is_described() {
    let io = FakeIo::new(vec![Reply::json(
      200,
      json!({"markdown": "x", "failed_pages": null}),
    )]);
    let config = test_config();
    let mut request = test_request();
    request.zdr = true;
    request.custom_request_context = true;
    let client = client_for(&io, &config, &request);
    client.ocr_sync("JVBERi0x", &job_options()).await.unwrap();

    let body = io.calls()[0].body.clone().unwrap();
    assert!(body.get("url").is_none());
    assert_eq!(body["zdr"], true);
    assert_eq!(body["source_request_context"], "custom");
    assert!(body.get("timeout").is_none());
  }

  #[tokio::test]
  async fn page_markdown_blocks_and_markers_are_requested_and_enforced() {
    let config = test_config();
    let request = test_request();
    let mut options = job_options();
    options.page_markdown = true;
    options.blocks = true;
    options.page_markers = true;

    let io = FakeIo::new(vec![Reply::json(
      200,
      json!({
        "markdown": "a\n\n---\n\n<!-- page 2 -->\n\nb", "failed_pages": null,
        "pages": [{"page": 1, "markdown": "a"}, {"page": 2, "markdown": "b"}],
        "blocks": [],
        "page_markers": true
      }),
    )]);
    let result = client_for(&io, &config, &request)
      .ocr_sync("JVBERi0x", &options)
      .await
      .unwrap();
    assert_eq!(result.page_markdown.unwrap().len(), 2);
    assert_eq!(result.blocks, Some(vec![]));
    let body = io.calls()[0].body.clone().unwrap();
    assert_eq!(body["include_page_markdown"], true);
    assert_eq!(body["include_blocks"], true);
    assert_eq!(body["page_markers"], true);

    for (reply, message) in [
      (
        json!({"markdown": "x", "failed_pages": null, "blocks": [], "page_markers": true}),
        "physical page markdown",
      ),
      (
        json!({"markdown": "x", "failed_pages": null, "pages": [], "page_markers": true}),
        "typed blocks",
      ),
      (
        json!({"markdown": "x", "failed_pages": null, "pages": [], "blocks": []}),
        "page markers",
      ),
    ] {
      let io = FakeIo::new(vec![Reply::json(200, reply)]);
      let error = client_for(&io, &config, &request)
        .ocr_sync("JVBERi0x", &options)
        .await
        .unwrap_err();
      assert!(error.to_string().contains(message), "{error}");
    }
  }

  #[tokio::test]
  async fn failure_statuses_and_bad_bodies_are_errors() {
    let config = test_config();
    let request = test_request();
    let io = FakeIo::new(vec![Reply::json(503, json!({"error": "busy"}))]);
    assert!(matches!(
      client_for(&io, &config, &request)
        .ocr_sync("x", &job_options())
        .await,
      Err(FirePdfError::Status(503))
    ));
    let io = FakeIo::new(vec![Reply::json(200, json!({"no": "markdown"}))]);
    assert!(matches!(
      client_for(&io, &config, &request)
        .ocr_sync("x", &job_options())
        .await,
      Err(FirePdfError::Schema(_))
    ));
    let io = FakeIo::new(vec![Reply::TransportError]);
    assert!(matches!(
      client_for(&io, &config, &request)
        .ocr_sync("x", &job_options())
        .await,
      Err(FirePdfError::Transport(_))
    ));
  }

  #[tokio::test]
  async fn keeps_the_estimate_when_fire_pdf_does_not_report_pages() {
    let io = FakeIo::new(vec![Reply::json(
      200,
      json!({"markdown": "x", "failed_pages": null}),
    )]);
    let config = test_config();
    let request = test_request();
    let mut options = job_options();
    options.pages_estimate = 7;
    let result = client_for(&io, &config, &request)
      .ocr_sync("x", &options)
      .await
      .unwrap();
    assert_eq!(result.pages_processed, 7);
  }
}
