//! `GET /jobs/:id/result`, and cancelling a job this attempt abandons.

use std::time::Duration;

use tracing::{Instrument, Span, field::Empty};

use super::super::{
  FallbackReason, FirePdfClient, FirePdfError,
  io::{self, HttpRequest, Method},
  schedule::POLL_FLOOR_MS,
  schema::{OcrDocument, ResultResponse},
};

const CANCEL_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Default)]
pub(super) struct JobProgress {
  pub submission_accepted: bool,
  pub terminal_reached: bool,
}

/// Covers the scrape deadline dropping an attempt mid-flight: records where it was
/// abandoned and cancels an inline job, whose work is discarded anyway.
pub(super) struct AbandonGuard {
  armed: bool,
  pub phase: &'static str,
  pub cancel: Option<HttpRequest>,
  span: Span,
}

impl AbandonGuard {
  pub fn new(phase: &'static str, cancel: Option<HttpRequest>) -> Self {
    Self {
      armed: true,
      phase,
      cancel,
      span: Span::current(),
    }
  }

  pub fn disarm(&mut self) {
    self.armed = false;
  }
}

impl Drop for AbandonGuard {
  fn drop(&mut self) {
    if !self.armed {
      return;
    }
    self.span.record("fire_pdf.abandoned_phase", self.phase);
    let Some(request) = self.cancel.take() else {
      return;
    };
    let Ok(handle) = tokio::runtime::Handle::try_current() else {
      return;
    };
    let cancel_span = tracing::info_span!(
      parent: &self.span,
      "FirePdfClient::cancel_job",
      http.status = Empty,
    );
    handle.spawn(send_cancel(request).instrument(cancel_span));
  }
}

/// fire-pdf accepts a cancel with 200, or 404 when the job is already gone.
async fn send_cancel(request: HttpRequest) {
  match io::send_http(request).await {
    Ok(response) => {
      Span::current().record("http.status", response.status);
      if response.status != 200 && response.status != 404 {
        tracing::error!(http.status = response.status, "cancellation not accepted");
      }
    }
    Err(error) => tracing::error!(error = %error),
  }
}

impl FirePdfClient<'_> {
  pub(super) fn cancel_request(&self, scrape_id: &str) -> HttpRequest {
    HttpRequest {
      method: Method::Delete,
      url: format!("{}/jobs/{}", self.base_url, scrape_id),
      bearer: self.config.api_key.clone(),
      json: None,
      timeout: Some(CANCEL_TIMEOUT),
    }
  }

  #[tracing::instrument(
    name = "FirePdfClient::fetch_result",
    skip_all,
    fields(http.status = Empty, fire_pdf.retried_409 = Empty, fire_pdf.transport_error = Empty),
    err
  )]
  pub(super) async fn fetch_result(&self, scrape_id: &str) -> Result<OcrDocument, FirePdfError> {
    let span = Span::current();
    let mut retried_409 = false;
    loop {
      let response = self
        .send(
          Method::Get,
          format!("{}/jobs/{}/result", self.base_url, scrape_id),
          None,
          None,
        )
        .await
        .map_err(|error| {
          span.record("fire_pdf.transport_error", error.as_str());
          FirePdfError::Async(FallbackReason::NetworkError)
        })?;
      span.record("http.status", response.status);
      let reason = match response.status {
        200 => {
          return ResultResponse::parse(&response.body)
            .map(|x| x.document)
            .map_err(|_| FirePdfError::Async(FallbackReason::Http5xx));
        }
        409 if !retried_409 => {
          retried_409 = true;
          span.record("fire_pdf.retried_409", true);
          io::sleep(POLL_FLOOR_MS).await;
          continue;
        }
        401 => FallbackReason::Http401,
        503 => FallbackReason::Result503,
        _ => FallbackReason::Http5xx,
      };
      return Err(FirePdfError::Async(reason));
    }
  }

  /// Best-effort cleanup after abandoning an accepted job.
  #[tracing::instrument(name = "FirePdfClient::cancel_job", skip_all, fields(http.status = Empty))]
  pub(super) async fn cancel_job(&self, scrape_id: &str) {
    send_cancel(self.cancel_request(scrape_id)).await;
  }
}
