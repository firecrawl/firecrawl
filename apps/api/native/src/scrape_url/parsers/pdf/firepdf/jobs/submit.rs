//! `POST /jobs`.

use std::fmt::Display;

use serde_json::Value;
use tracing::{Span, field::Empty};

use super::super::{
  FallbackReason, FirePdfClient, FirePdfError, FirePdfJobOptions,
  io::{self, HttpResponse, Method},
  schedule::SUBMIT_TRANSIENT_RETRY_DELAY_MS,
  schema::{
    SubmitInputWire, SubmitRequest, SubmitResponse, SubmitStatus, fire_pdf_503_code,
    is_fastify_closing_body,
  },
};

pub(super) struct SubmitOutcome {
  pub retry_after_ms: Option<i64>,
  pub already_done: bool,
}

pub(super) struct SubmitFailure {
  pub error: FirePdfError,
  /// The submit may have reached fire-pdf even though no valid success came back.
  pub maybe_accepted: bool,
}

impl From<FirePdfError> for SubmitFailure {
  fn from(error: FirePdfError) -> Self {
    Self {
      error,
      maybe_accepted: false,
    }
  }
}

impl Display for SubmitFailure {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    self.error.fmt(f)
  }
}

fn possibly_accepted(reason: FallbackReason) -> SubmitFailure {
  SubmitFailure {
    error: FirePdfError::Async(reason),
    maybe_accepted: true,
  }
}

/// fire-pdf's answer to a submit, as a fallback reason. 409 is fatal, not a fallback.
fn check_submit_status(status: u16, json: &Value) -> Result<(), SubmitFailure> {
  let span = Span::current();
  let reason = match status {
    200 | 202 => return Ok(()),
    400 => {
      let code = json.get("error").and_then(Value::as_str);
      span.record("fire_pdf.submit_error_code", code.unwrap_or("unattributed"));
      FallbackReason::Http400
    }
    401 => FallbackReason::Http401,
    404 => FallbackReason::Http404,
    409 => {
      return Err(
        FirePdfError::Contract(
          "fire-pdf async POST /jobs conflict: scrape_id reused with different inputs",
        )
        .into(),
      );
    }
    410 => FallbackReason::Http410,
    413 => FallbackReason::Http413,
    429 => FallbackReason::Http429,
    502 => FallbackReason::Http502,
    503 => {
      let code = fire_pdf_503_code(json).unwrap_or("unattributed");
      span.record("fire_pdf.submit_error_code", code);
      FallbackReason::Http503
    }
    _ => FallbackReason::Http5xx,
  };
  Err(FirePdfError::Async(reason).into())
}

impl FirePdfClient<'_> {
  #[tracing::instrument(
    name = "FirePdfClient::submit_job",
    skip_all,
    fields(
      fire_pdf.deadline_at = deadline_at,
      fire_pdf.retry_trigger = Empty,
      fire_pdf.transport_error = Empty,
      http.status = Empty,
      fire_pdf.submit_error_code = Empty,
      fire_pdf.lane = Empty,
      fire_pdf.already_done = Empty,
    ),
    err
  )]
  pub(super) async fn submit_job(
    &self,
    input: &SubmitInputWire<'_>,
    options: &FirePdfJobOptions,
    deadline_at: &str,
  ) -> Result<SubmitOutcome, SubmitFailure> {
    if matches!(input, SubmitInputWire::ByReference { .. }) && options.pages_estimate == 0 {
      // fire-pdf rejects these with 400 missing_pages_estimate.
      return Err(
        FirePdfError::Contract("fire-pdf by-reference submit requires a positive pages estimate")
          .into(),
      );
    }
    let body = self.submit_body(input, options, deadline_at)?;
    let response = self.post_job(body).await?;
    let span = Span::current();
    span.record("http.status", response.status);
    let json = response.json_or_empty();
    check_submit_status(response.status, &json)?;

    // A 2xx means the scrape_id was accepted even though the body is unusable.
    let parsed: SubmitResponse =
      serde_json::from_value(json).map_err(|_| possibly_accepted(FallbackReason::Http5xx))?;
    let already_done = response.status == 200 && parsed.status == SubmitStatus::Done;
    span.record("fire_pdf.lane", parsed.lane.as_str());
    span.record("fire_pdf.already_done", already_done);
    Ok(SubmitOutcome {
      retry_after_ms: parsed.retry_after_ms,
      already_done,
    })
  }

  fn submit_body(
    &self,
    input: &SubmitInputWire<'_>,
    options: &FirePdfJobOptions,
    deadline_at: &str,
  ) -> Result<Vec<u8>, FirePdfError> {
    let request = self.request;
    serde_json::to_vec(&SubmitRequest {
      input: match *input {
        SubmitInputWire::Inline { pdf_b64 } => SubmitInputWire::Inline { pdf_b64 },
        SubmitInputWire::ByReference {
          input_gcs_uri,
          input_sha256,
        } => SubmitInputWire::ByReference {
          input_gcs_uri,
          input_sha256,
        },
      },
      scrape_id: &request.scrape_id,
      source: "firecrawl",
      metadata: request.metadata(),
      zdr: false,
      deadline_at,
      team_id: (!request.team_id.is_empty()).then_some(request.team_id.as_str()),
      crawl_id: request.crawl_id.as_deref(),
      team_concurrency: request.team_concurrency,
      options: options.wire(),
    })
    .map_err(|e| FirePdfError::Schema(e.to_string()))
  }

  /// One retry for a submit that provably never reached fire-pdf's handler. POST /jobs is
  /// idempotent on scrape_id, so a first request that did land is replayed, never duplicated.
  async fn post_job(&self, body: Vec<u8>) -> Result<HttpResponse, SubmitFailure> {
    let url = format!("{}/jobs", self.base_url);
    let span = Span::current();
    let mut first_attempt = true;
    loop {
      let retry_trigger = match self
        .send(Method::Post, url.clone(), Some(body.clone()), None)
        .await
      {
        Err(error) => {
          span.record("fire_pdf.transport_error", error.as_str());
          if !first_attempt {
            return Err(possibly_accepted(FallbackReason::NetworkError));
          }
          "transport_error"
        }
        Ok(response) if first_attempt && response.status == 503 => {
          let json = response.json_or_empty();
          if fire_pdf_503_code(&json).is_some() {
            return Ok(response);
          }
          if is_fastify_closing_body(&json) {
            "http_503_closing"
          } else {
            "http_503_unattributed"
          }
        }
        Ok(response) => return Ok(response),
      };
      span.record("fire_pdf.retry_trigger", retry_trigger);
      first_attempt = false;
      io::sleep(SUBMIT_TRANSIENT_RETRY_DELAY_MS).await;
    }
  }
}
