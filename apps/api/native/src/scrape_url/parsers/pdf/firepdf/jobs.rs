//! fire-pdf's async job protocol: `POST /jobs`, poll `GET /jobs/:id`, fetch
//! `GET /jobs/:id/result`, cancel with `DELETE /jobs/:id`, and adopt an existing
//! job through `POST /jobs/lookup`.

use std::time::Duration;

use chrono::{DateTime, SecondsFormat};
use serde_json::Value;
use tracing::{Instrument, Span, field::Empty};

use super::{
  FallbackReason, FirePdfClient, FirePdfError, FirePdfJobOptions, FirePdfResult,
  io::{self, FirePdfIo, HttpRequest, Method},
  log_provenance,
  schedule::{
    EarlyPollState, LONG_POLL_HELD_FRACTION, LONG_POLL_MAX_EARLY_ANSWERS,
    MIN_ASYNC_CALLER_WINDOW_MS, POLL_CAP_MS, POLL_FLOOR_MS, POLL_TIMEOUT_BUFFER_MS,
    SUBMIT_TRANSIENT_RETRY_DELAY_MS, align_poll_delay, compute_by_reference_deadline_ms,
    compute_deadline_ms, compute_inline_job_deadline_ms, early_poll_delay, long_poll_wait_for,
    next_poll_delay,
  },
  schema::{
    AdoptionLookupRequest, JobStatus, OcrDocument, PollResponse, Provenance, ResultResponse,
    SubmitInputWire, SubmitRequest, SubmitResponse, SubmitStatus, fire_pdf_503_code,
    is_fastify_closing_body,
  },
  sha256_hex, truncate,
};

const CANCEL_TIMEOUT: Duration = Duration::from_secs(2);
/// The adoption lookup is a pure optimization; this keeps a hung fire-pdf from eating the scrape budget.
const ADOPTION_LOOKUP_TIMEOUT: Duration = Duration::from_secs(10);

/// What an async attempt hands fire-pdf.
pub enum AsyncInput<'a> {
  /// Base64 PDF in the submit body.
  Inline(&'a str),
  /// A PDF already placed in fire-pdf's input bucket.
  ByReference { gcs_uri: &'a str, sha256: &'a str },
  /// A live or finished job for the same bytes and options, found by content lookup.
  Adopted { scrape_id: &'a str, sha256: &'a str },
}

struct SubmitOutcome {
  retry_after_ms: Option<i64>,
  already_done: bool,
}

struct SubmitFailure {
  error: FirePdfError,
  /// The submit may have reached fire-pdf even though no valid success came back.
  maybe_accepted: bool,
}

impl From<FirePdfError> for SubmitFailure {
  fn from(error: FirePdfError) -> Self {
    Self {
      error,
      maybe_accepted: false,
    }
  }
}

struct PollPlan<'a> {
  scrape_id: &'a str,
  /// fire-pdf's `retry_after_ms` from the submit response.
  initial_delay: Option<i64>,
  /// Selects the page-aware early schedule; 0 keeps plain backoff.
  pages_estimate: u32,
  long_poll_wait_ms: i64,
  polling_deadline: i64,
  /// Only an inline job's own deadline sits inside this caller's window.
  job_deadline_at_ms: Option<i64>,
}

#[derive(Default)]
struct PollStats {
  poll_count: u32,
  long_poll_terminal: u32,
  long_poll_held: u32,
  long_poll_not_held: u32,
}

/// Logs and counts an exit from the async path on the current `fire_pdf::async` span.
fn fail_async(reason: FallbackReason, detail: &str) -> FirePdfError {
  tracing::warn!(
    reason = reason.as_str(),
    detail = truncate(detail, 500),
    "FirePDF async failed"
  );
  Span::current().record("fire_pdf.fallback_reason", reason.as_str());
  FirePdfError::Async(reason)
}

/// Covers the scrape deadline dropping an attempt mid-flight: logs where it was
/// abandoned and cancels an inline job, whose work is discarded anyway.
struct AbandonGuard {
  armed: bool,
  phase: &'static str,
  cancel: Option<HttpRequest>,
}

impl Drop for AbandonGuard {
  fn drop(&mut self) {
    if !self.armed {
      return;
    }
    tracing::warn!(
      phase = self.phase,
      "FirePDF async abandoned by caller abort"
    );
    if let Some(request) = self.cancel.take()
      && let Ok(handle) = tokio::runtime::Handle::try_current()
    {
      handle.spawn(async move {
        if let Err(error) = io::send_http(request).await {
          tracing::warn!(error, "FirePDF async cancellation failed");
        }
      });
    }
  }
}

impl<I: FirePdfIo> FirePdfClient<'_, I> {
  /// One async attempt: submit (unless adopting), poll until terminal, fetch the result.
  pub async fn run_async(
    &self,
    input: AsyncInput<'_>,
    options: &FirePdfJobOptions,
  ) -> Result<FirePdfResult, FirePdfError> {
    let span = tracing::info_span!(
      "fire_pdf::async",
      fire_pdf.input = match input {
        AsyncInput::Inline(_) => "inline",
        AsyncInput::ByReference { .. } => "by_reference",
        AsyncInput::Adopted { .. } => "adopted",
      },
      fire_pdf.job_scrape_id = Empty,
      fire_pdf.deadline_at = Empty,
      fire_pdf.lane = Empty,
      fire_pdf.submit_retry_trigger = Empty,
      fire_pdf.submit_503_code = Empty,
      fire_pdf.poll_count = Empty,
      fire_pdf.long_poll.terminal = Empty,
      fire_pdf.long_poll.held = Empty,
      fire_pdf.long_poll.not_held = Empty,
      fire_pdf.terminal_status = Empty,
      fire_pdf.fallback_reason = Empty,
      fire_pdf.pages_processed = Empty,
      fire_pdf.markdown_length = Empty,
      fire_pdf.duration_ms = Empty,
      fire_pdf.cache_key = Empty,
      fire_pdf.generation = Empty,
      fire_pdf.build_sha = Empty,
    );
    self
      .run_async_inner(input, options, &span)
      .instrument(span.clone())
      .await
  }

  async fn run_async_inner(
    &self,
    input: AsyncInput<'_>,
    options: &FirePdfJobOptions,
    span: &Span,
  ) -> Result<FirePdfResult, FirePdfError> {
    // Async persists inputs and queue state; routing keeps ZDR out of it.
    if self.request.zdr {
      return match input {
        AsyncInput::Inline(pdf_b64) => self.ocr_sync(pdf_b64, options).await,
        _ => Err(FirePdfError::Contract(
          "fire-pdf by-reference submit is not available under zero data retention",
        )),
      };
    }

    let remaining_ms = self.remaining_ms();
    if let Some(remaining_ms) = remaining_ms
      && remaining_ms < MIN_ASYNC_CALLER_WINDOW_MS
    {
      return Err(fail_async(
        FallbackReason::DeadlineTooClose,
        &format!("remaining_ms={remaining_ms}"),
      ));
    }

    let (job_scrape_id, wire_input, cache_key) = match &input {
      AsyncInput::Inline(pdf_b64) => (
        self.request.scrape_id.as_str(),
        Some(SubmitInputWire::Inline { pdf_b64 }),
        sha256_hex(pdf_b64.as_bytes()),
      ),
      AsyncInput::ByReference { gcs_uri, sha256 } => (
        self.request.scrape_id.as_str(),
        Some(SubmitInputWire::ByReference {
          input_gcs_uri: gcs_uri,
          input_sha256: sha256,
        }),
        format!("raw-{}", sha256.to_lowercase()),
      ),
      AsyncInput::Adopted { scrape_id, sha256 } => {
        (*scrape_id, None, format!("raw-{}", sha256.to_lowercase()))
      }
    };
    let is_inline = matches!(input, AsyncInput::Inline(_));
    span.record("fire_pdf.job_scrape_id", job_scrape_id);
    span.record("fire_pdf.cache_key", cache_key.as_str());

    let submit_time = self.io.now_ms();
    // This attempt polls for the caller's window. The job deadline of an inline
    // job sits inside it; a by-reference job outlives its caller on purpose, so
    // the customer's retry converges on its result.
    let caller_window_ms = compute_deadline_ms(remaining_ms);
    let job_deadline_at_ms = submit_time
      + if matches!(input, AsyncInput::ByReference { .. }) {
        compute_by_reference_deadline_ms(remaining_ms, options.pages_estimate)
      } else {
        compute_inline_job_deadline_ms(caller_window_ms)
      };
    let deadline_at = DateTime::from_timestamp_millis(job_deadline_at_ms)
      .map(|x| x.to_rfc3339_opts(SecondsFormat::Millis, true))
      .ok_or(FirePdfError::Contract(
        "FirePDF job deadline is out of range",
      ))?;
    let polling_deadline = submit_time + caller_window_ms + POLL_TIMEOUT_BUFFER_MS;
    if wire_input.is_some() {
      span.record("fire_pdf.deadline_at", deadline_at.as_str());
    }

    // Only an abandoned inline job is cancelled: an adopted job is not ours,
    // and a by-reference job finishes into the content cache for the retry.
    let mut guard = AbandonGuard {
      armed: true,
      phase: if wire_input.is_some() {
        "submit"
      } else {
        "poll"
      },
      cancel: is_inline.then(|| HttpRequest {
        method: Method::Delete,
        url: format!("{}/jobs/{}", self.base_url, job_scrape_id),
        bearer: self.config.api_key.clone(),
        json: None,
        timeout: Some(CANCEL_TIMEOUT),
      }),
    };
    let mut submission_accepted = false;
    let mut terminal_reached = false;

    let attempt = async {
      let (already_done, initial_delay) = match &wire_input {
        None => {
          tracing::info!(
            adopted_scrape_id = job_scrape_id,
            "FirePDF async adopting existing job"
          );
          (false, None)
        }
        Some(wire) => {
          let submit = self
            .submit_job(wire, options, &deadline_at, span)
            .await
            .map_err(|f| (f.error, f.maybe_accepted))?;
          submission_accepted = true;
          (submit.already_done, submit.retry_after_ms)
        }
      };
      terminal_reached = already_done;

      guard.phase = "poll";
      let poll_pages = if already_done {
        None
      } else {
        let plan = PollPlan {
          scrape_id: job_scrape_id,
          initial_delay,
          pages_estimate: options.pages_estimate,
          long_poll_wait_ms: self.config.async_wait_ms,
          polling_deadline,
          job_deadline_at_ms: is_inline.then_some(job_deadline_at_ms),
        };
        let mut stats = PollStats::default();
        let polled = self.poll_until_terminal(&plan, &mut stats).await;
        span.record("fire_pdf.poll_count", stats.poll_count);
        span.record("fire_pdf.long_poll.terminal", stats.long_poll_terminal);
        span.record("fire_pdf.long_poll.held", stats.long_poll_held);
        span.record("fire_pdf.long_poll.not_held", stats.long_poll_not_held);
        polled.map_err(|e| (e, false))?
      };
      terminal_reached = true;

      guard.phase = "result";
      guard.cancel = None;
      let fetched = self
        .fetch_result(job_scrape_id)
        .await
        .map_err(|e| (e, false))?;
      Ok::<_, (FirePdfError, bool)>((fetched, poll_pages))
    }
    .await;
    guard.armed = false;

    let (document, poll_pages) = match attempt {
      Ok(x) => x,
      Err((error, maybe_accepted)) => {
        let job_already_terminal =
          matches!(&error, FirePdfError::Async(reason) if reason.is_terminal());
        if is_inline
          && (submission_accepted || maybe_accepted)
          && !terminal_reached
          && !job_already_terminal
        {
          self.cancel_job(job_scrape_id).await;
        }
        return Err(error);
      }
    };

    if options.page_markdown && document.pages.is_none() {
      return Err(fail_async(
        FallbackReason::Http5xx,
        "FirePDF result omitted requested physical page markdown",
      ));
    }
    if options.blocks && document.blocks.is_none() {
      return Err(fail_async(
        FallbackReason::Http5xx,
        "FirePDF result omitted requested typed blocks",
      ));
    }
    // Markers are baked into the markdown, so the echo is the only proof the worker honored them.
    if options.page_markers && document.page_markers != Some(true) {
      return Err(fail_async(
        FallbackReason::Http5xx,
        "FirePDF result did not acknowledge requested page markers",
      ));
    }

    let pages_processed = document
      .pages_processed
      .or(poll_pages)
      .unwrap_or(options.pages_estimate);
    let duration_ms = self.io.now_ms() - submit_time;
    let provenance = Provenance::parse(document.provenance.as_ref());
    log_provenance(&provenance, &cache_key);

    span.record("fire_pdf.pages_processed", pages_processed);
    span.record("fire_pdf.markdown_length", document.markdown.len());
    span.record("fire_pdf.duration_ms", duration_ms);
    span.record("fire_pdf.generation", provenance.generation());
    span.record("fire_pdf.build_sha", provenance.build_sha());
    tracing::info!(
      duration_ms,
      markdown_length = document.markdown.len(),
      pages_processed,
      page_markdown_pages = document.pages.as_ref().map(Vec::len),
      block_pages = document.blocks.as_ref().map(Vec::len),
      failed_pages = document.failed_pages.as_ref().map_or(0, Vec::len),
      partial_pages = document.partial_pages.as_ref().map_or(0, Vec::len),
      "FirePDF async completed"
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

  async fn submit_job(
    &self,
    input: &SubmitInputWire<'_>,
    options: &FirePdfJobOptions,
    deadline_at: &str,
    span: &Span,
  ) -> Result<SubmitOutcome, SubmitFailure> {
    let request = self.request;
    if matches!(input, SubmitInputWire::ByReference { .. }) && options.pages_estimate == 0 {
      // fire-pdf rejects these with 400 missing_pages_estimate.
      return Err(
        FirePdfError::Contract("fire-pdf by-reference submit requires a positive pages estimate")
          .into(),
      );
    }

    let body = serde_json::to_vec(&SubmitRequest {
      input: match input {
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
    .map_err(|e| FirePdfError::Schema(e.to_string()))?;

    // One retry for a submit that provably never reached fire-pdf's handler. POST /jobs is
    // idempotent on scrape_id, so a first request that did land is replayed, never duplicated.
    let url = format!("{}/jobs", self.base_url);
    let mut first_attempt = true;
    let response = loop {
      let retry_trigger = match self
        .send(Method::Post, url.clone(), Some(body.clone()), None)
        .await
      {
        Err(error) if first_attempt => {
          tracing::info!(error, "FirePDF async POST /jobs retrying once");
          "transport_error"
        }
        Err(error) => {
          return Err(SubmitFailure {
            error: fail_async(FallbackReason::NetworkError, &error),
            maybe_accepted: true,
          });
        }
        Ok(response) if first_attempt && response.status == 503 => {
          let json = response.json_or_empty();
          if fire_pdf_503_code(&json).is_some() {
            break response;
          }
          if is_fastify_closing_body(&json) {
            "http_503_closing"
          } else {
            "http_503_unattributed"
          }
        }
        Ok(response) => break response,
      };
      span.record("fire_pdf.submit_retry_trigger", retry_trigger);
      first_attempt = false;
      self.io.sleep(SUBMIT_TRANSIENT_RETRY_DELAY_MS).await;
    };

    let status = response.status;
    let json = response.json_or_empty();
    let detail = || truncate(&json.to_string(), 500).to_string();
    let reason = match status {
      200 | 202 => None,
      400 => {
        let code = json
          .get("error")
          .and_then(Value::as_str)
          .unwrap_or("unattributed");
        tracing::error!(
          code,
          "FirePDF async POST /jobs returned 400 validation error"
        );
        Some(FallbackReason::Http400)
      }
      401 => Some(FallbackReason::Http401),
      404 => Some(FallbackReason::Http404),
      409 => {
        tracing::error!(
          body = detail(),
          "FirePDF async POST /jobs returned 409 scrape_id_conflict"
        );
        return Err(
          FirePdfError::Contract(
            "fire-pdf async POST /jobs conflict: scrape_id reused with different inputs",
          )
          .into(),
        );
      }
      410 => Some(FallbackReason::Http410),
      413 => Some(FallbackReason::Http413),
      429 => Some(FallbackReason::Http429),
      502 => Some(FallbackReason::Http502),
      503 => {
        let code = fire_pdf_503_code(&json).unwrap_or("unattributed");
        span.record("fire_pdf.submit_503_code", code);
        Some(FallbackReason::Http503)
      }
      _ => Some(FallbackReason::Http5xx),
    };
    if let Some(reason) = reason {
      return Err(fail_async(reason, &format!("status={status} body={}", detail())).into());
    }

    let parsed: SubmitResponse = match serde_json::from_value(json.clone()) {
      Ok(x) => x,
      Err(e) => {
        // A 2xx means the scrape_id was accepted even though the body is unusable.
        return Err(SubmitFailure {
          error: fail_async(FallbackReason::Http5xx, &format!("{e}: {}", detail())),
          maybe_accepted: true,
        });
      }
    };

    span.record("fire_pdf.lane", parsed.lane.as_str());
    tracing::info!(
      http_status = status,
      lane = parsed.lane.as_str(),
      deadline_at,
      "FirePDF async POST /jobs accepted"
    );
    Ok(SubmitOutcome {
      retry_after_ms: parsed.retry_after_ms,
      already_done: status == 200 && parsed.status == SubmitStatus::Done,
    })
  }

  async fn poll_until_terminal(
    &self,
    plan: &PollPlan<'_>,
    stats: &mut PollStats,
  ) -> Result<Option<u32>, FirePdfError> {
    let io = self.io;
    let mut last_delay = next_poll_delay(0, plan.initial_delay, io.random());
    let started_at = io.now_ms();
    let mut retry_after_ms = plan.initial_delay;
    let mut fast_poll_count = 0;
    let mut in_early_schedule = false;
    // Cleared for the rest of the job after repeated early answers to wait_ms.
    let mut long_poll_active = plan.long_poll_wait_ms > 0;
    let mut early_answers = 0;

    loop {
      // After an early answer, pause once on the floor before the next wait_ms
      // request; when no long-poll would fit after it, take the scheduled path.
      let mut scheduled_this_round = false;
      if long_poll_active && early_answers > 0 {
        let pause_ms = POLL_FLOOR_MS.max(POLL_CAP_MS.min(retry_after_ms.unwrap_or(0)));
        let fits_after_pause = long_poll_wait_for(
          plan.long_poll_wait_ms,
          plan.polling_deadline - io.now_ms() - pause_ms,
        ) > 0;
        if fits_after_pause {
          io.sleep(pause_ms).await;
        } else {
          scheduled_this_round = true;
        }
      }
      if io.now_ms() > plan.polling_deadline {
        return Err(fail_async(
          FallbackReason::PollingTimeout,
          &format!("poll_count={}", stats.poll_count),
        ));
      }

      let wait_ms = if long_poll_active && !scheduled_this_round {
        long_poll_wait_for(plan.long_poll_wait_ms, plan.polling_deadline - io.now_ms())
      } else {
        0
      };
      // A long-poll is sent right away: the server does the waiting.
      let mut early = None;
      if wait_ms == 0 {
        early = early_poll_delay(&EarlyPollState {
          pages_estimate: plan.pages_estimate,
          elapsed_ms: io.now_ms() - started_at,
          poll_count: stats.poll_count,
          fast_poll_count,
          retry_after_ms,
          random: io.random(),
        });
        if early.is_some() && stats.poll_count > 0 {
          fast_poll_count += 1;
        }
        if early.is_some() {
          in_early_schedule = true;
        } else if in_early_schedule {
          // Handover: backoff restarts from the floor (or the latest hint).
          in_early_schedule = false;
          last_delay = next_poll_delay(0, retry_after_ms, io.random());
        }
        io.sleep(align_poll_delay(
          early.unwrap_or(last_delay),
          io.now_ms(),
          plan.job_deadline_at_ms,
        ))
        .await;
      }
      stats.poll_count += 1;

      let url = if wait_ms > 0 {
        format!(
          "{}/jobs/{}?wait_ms={wait_ms}",
          self.base_url, plan.scrape_id
        )
      } else {
        format!("{}/jobs/{}", self.base_url, plan.scrape_id)
      };
      let sent_at = io.now_ms();
      let response = self
        .send(Method::Get, url, None, None)
        .await
        .map_err(|e| fail_async(FallbackReason::NetworkError, &e))?;
      let body = response.json_or_empty();
      let parsed = serde_json::from_value::<PollResponse>(body.clone());

      match response.status {
        401 => return Err(fail_async(FallbackReason::Http401, "")),
        404 => {
          return Err(FirePdfError::Contract(
            "fire-pdf async GET /jobs/:id 404: scrape_id missing after successful submit",
          ));
        }
        410 => {
          if wait_ms > 0 {
            stats.long_poll_terminal += 1;
          }
          let status = parsed.map(|x| x.status).unwrap_or(JobStatus::Expired);
          Span::current().record("fire_pdf.terminal_status", status.as_str());
          let reason = if status == JobStatus::Cancelled {
            FallbackReason::TerminalCancelled
          } else {
            FallbackReason::TerminalExpired
          };
          return Err(fail_async(reason, &body.to_string()));
        }
        502 => {
          if wait_ms > 0 {
            stats.long_poll_terminal += 1;
          }
          Span::current().record("fire_pdf.terminal_status", "failed");
          return Err(fail_async(
            FallbackReason::TerminalFailed,
            &body.to_string(),
          ));
        }
        200 | 202 => {}
        status => {
          return Err(fail_async(
            FallbackReason::Http5xx,
            &format!("status={status} body={body}"),
          ));
        }
      }
      let poll =
        parsed.map_err(|e| fail_async(FallbackReason::Http5xx, &format!("{e}: {body}")))?;

      if poll.status.is_terminal() {
        if wait_ms > 0 {
          stats.long_poll_terminal += 1;
        }
        Span::current().record("fire_pdf.terminal_status", poll.status.as_str());
        let reason = match poll.status {
          JobStatus::Failed => FallbackReason::TerminalFailed,
          JobStatus::Expired => FallbackReason::TerminalExpired,
          JobStatus::Cancelled => FallbackReason::TerminalCancelled,
          _ => return Ok(poll.pages_processed),
        };
        return Err(fail_async(
          reason,
          &format!(
            "error_class={} error_message={}",
            poll.error_class.as_deref().unwrap_or(""),
            poll.error_message.as_deref().unwrap_or("")
          ),
        ));
      }

      if wait_ms > 0 {
        let held = (io.now_ms() - sent_at) as f64 >= wait_ms as f64 * LONG_POLL_HELD_FRACTION;
        if held {
          stats.long_poll_held += 1;
          early_answers = 0;
        } else {
          stats.long_poll_not_held += 1;
          early_answers += 1;
        }
        if early_answers >= LONG_POLL_MAX_EARLY_ANSWERS {
          long_poll_active = false;
        }
      }

      retry_after_ms = poll.retry_after_ms;
      // Backoff advances only while it is the schedule in use.
      if wait_ms == 0 && early.is_none() {
        last_delay = next_poll_delay(last_delay, retry_after_ms, io.random());
      }
    }
  }

  async fn fetch_result(&self, scrape_id: &str) -> Result<OcrDocument, FirePdfError> {
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
        .map_err(|e| fail_async(FallbackReason::NetworkError, &e))?;
      match response.status {
        200 => {}
        401 => return Err(fail_async(FallbackReason::Http401, "")),
        503 => {
          return Err(fail_async(
            FallbackReason::Result503,
            &response.json_or_empty().to_string(),
          ));
        }
        409 if !retried_409 => {
          retried_409 = true;
          tracing::info!("FirePDF async result returned 409, re-polling once");
          self.io.sleep(POLL_FLOOR_MS).await;
          continue;
        }
        status => {
          return Err(fail_async(
            FallbackReason::Http5xx,
            &format!("status={status} body={}", response.json_or_empty()),
          ));
        }
      }
      return ResultResponse::parse(&response.body)
        .map(|x| x.document)
        .map_err(|e| fail_async(FallbackReason::Http5xx, &e));
    }
  }

  /// Best-effort cleanup after abandoning an accepted job.
  async fn cancel_job(&self, scrape_id: &str) {
    match self
      .send(
        Method::Delete,
        format!("{}/jobs/{}", self.base_url, scrape_id),
        None,
        Some(CANCEL_TIMEOUT),
      )
      .await
    {
      Ok(response) if response.status != 200 && response.status != 404 => {
        tracing::warn!(
          status = response.status,
          "FirePDF async cancellation was not accepted"
        );
      }
      Ok(_) => {}
      Err(error) => tracing::warn!(error, "FirePDF async cancellation failed"),
    }
  }

  /// A job fire-pdf already has for these exact bytes and options, scoped to this
  /// team. Best-effort: any failure means submitting fresh.
  pub async fn lookup_adoptable(
    &self,
    sha256: &str,
    options: &FirePdfJobOptions,
  ) -> Option<String> {
    let team_id = &self.request.team_id;
    let body = serde_json::to_vec(&AdoptionLookupRequest {
      input_sha256: sha256,
      team_id: (!team_id.is_empty()).then_some(team_id.as_str()),
      options: options.wire(),
    })
    .ok()?;
    let response = match self
      .send(
        Method::Post,
        format!("{}/jobs/lookup", self.base_url),
        Some(body),
        Some(ADOPTION_LOOKUP_TIMEOUT),
      )
      .await
    {
      Ok(response) => response,
      Err(error) => {
        tracing::warn!(error, "FirePDF adoption lookup failed; submitting fresh");
        return None;
      }
    };
    if response.status != 200 {
      if response.status != 404 {
        tracing::warn!(
          status = response.status,
          "FirePDF adoption lookup returned non-200; submitting fresh"
        );
      }
      return None;
    }
    let json = response.json_or_empty();
    let scrape_id = json.get("scrape_id")?.as_str().filter(|x| !x.is_empty())?;
    tracing::info!(
      adopted_scrape_id = scrape_id,
      adopted_status = json.get("status").and_then(serde_json::Value::as_str),
      "FirePDF adoption lookup hit"
    );
    Some(scrape_id.to_string())
  }
}

#[cfg(test)]
mod tests {
  use std::sync::atomic::{AtomicI64, Ordering};

  use serde_json::json;

  use super::super::testing::{
    FakeIo, RecordedCall, Reply, T0, client_for, job_options, test_config, test_request,
  };
  use super::*;

  fn done_poll() -> Reply {
    Reply::json(
      200,
      json!({"scrape_id": "x", "status": "done", "pages_processed": 1}),
    )
  }

  fn running_poll() -> Reply {
    Reply::json(202, json!({"scrape_id": "x", "status": "running"}))
  }

  fn result_body() -> Reply {
    Reply::json(
      200,
      json!({"schema_version": 1, "markdown": "# done", "pages_processed": 4}),
    )
  }

  fn accepted() -> Reply {
    Reply::json(
      202,
      json!({"scrape_id": "scrape-id-test", "status": "queued", "lane": "fast"}),
    )
  }

  fn methods(io: &FakeIo) -> Vec<(Method, String)> {
    io.calls()
      .into_iter()
      .map(|c| (c.method, c.url.replace("http://fire-pdf.test", "")))
      .collect()
  }

  fn with_deadline(io: &FakeIo, remaining_ms: i64) -> FirePdfRequest {
    let mut request = test_request();
    request.deadline_ms = Some(io.now_ms() + remaining_ms);
    request
  }

  use super::super::FirePdfRequest;

  #[tokio::test]
  async fn happy_path_submits_polls_and_fetches() {
    let io = FakeIo::new(vec![accepted(), done_poll(), result_body()]);
    let config = test_config();
    let request = with_deadline(&io, 60_000);
    let result = client_for(&io, &config, &request)
      .run_async(AsyncInput::Inline("JVBERi0x"), &job_options())
      .await
      .unwrap();
    assert_eq!(result.markdown, "# done");
    assert_eq!(result.pages_processed, 4);
    assert_eq!(
      methods(&io),
      vec![
        (Method::Post, "/jobs".to_string()),
        (Method::Get, "/jobs/scrape-id-test".to_string()),
        (Method::Get, "/jobs/scrape-id-test/result".to_string()),
      ]
    );
    let body = io.calls()[0].body.clone().unwrap();
    assert_eq!(body["pdf_b64"], "JVBERi0x");
    assert_eq!(body["scrape_id"], "scrape-id-test");
    assert_eq!(body["source"], "firecrawl");
    assert_eq!(body["source_endpoint"], "scrape");
    assert_eq!(body["source_kind"], "pdf");
    assert_eq!(body["url"], "https://example.com/doc.pdf");
    assert_eq!(body["zdr"], false);
    assert_eq!(body["team_id"], "team-x");
    assert_eq!(body["team_concurrency"], 12);
    assert_eq!(body["options"], json!({"mode": "auto"}));
    assert!(body.get("input_gcs_uri").is_none());
    // 60s window minus the 10s floor margin.
    let deadline_at = DateTime::from_timestamp_millis(T0 + 50_000)
      .unwrap()
      .to_rfc3339_opts(SecondsFormat::Millis, true);
    assert_eq!(body["deadline_at"], deadline_at);
  }

  #[tokio::test]
  async fn sends_a_positive_page_count_as_pages_estimate_and_omits_absent_team_context() {
    let io = FakeIo::new(vec![accepted(), done_poll(), result_body()]);
    let config = test_config();
    let mut request = with_deadline(&io, 60_000);
    request.team_concurrency = None;
    request.team_id = String::new();
    let mut options = job_options();
    options.pages_estimate = 3;
    options.max_pages = Some(2);
    client_for(&io, &config, &request)
      .run_async(AsyncInput::Inline("x"), &options)
      .await
      .unwrap();
    let body = io.calls()[0].body.clone().unwrap();
    assert_eq!(
      body["options"],
      json!({"mode": "auto", "pages_estimate": 3, "max_pages": 2})
    );
    assert!(body.get("team_id").is_none());
    assert!(body.get("team_concurrency").is_none());
  }

  #[tokio::test]
  async fn rejects_a_deadline_that_cannot_safely_enter_the_queue() {
    let io = FakeIo::new(vec![]);
    let config = test_config();
    let request = with_deadline(&io, MIN_ASYNC_CALLER_WINDOW_MS - 1);
    let error = client_for(&io, &config, &request)
      .run_async(AsyncInput::Inline("x"), &job_options())
      .await
      .unwrap_err();
    assert!(matches!(
      error,
      FirePdfError::Async(FallbackReason::DeadlineTooClose)
    ));
    assert!(io.calls().is_empty());
  }

  #[tokio::test]
  async fn keeps_zdr_on_the_sync_path() {
    let io = FakeIo::new(vec![Reply::json(
      200,
      json!({"markdown": "sync", "failed_pages": null}),
    )]);
    let config = test_config();
    let mut request = test_request();
    request.zdr = true;
    let client = client_for(&io, &config, &request);
    let result = client
      .run_async(AsyncInput::Inline("x"), &job_options())
      .await
      .unwrap();
    assert_eq!(result.markdown, "sync");
    assert_eq!(methods(&io), vec![(Method::Post, "/ocr".to_string())]);

    let error = client
      .run_async(
        AsyncInput::ByReference {
          gcs_uri: "gs://b/k",
          sha256: "ab",
        },
        &job_options(),
      )
      .await
      .unwrap_err();
    assert!(matches!(error, FirePdfError::Contract(_)));
  }

  #[tokio::test]
  async fn idempotent_replay_skips_polling() {
    let io = FakeIo::new(vec![
      Reply::json(
        200,
        json!({"scrape_id": "scrape-id-test", "status": "done"}),
      ),
      result_body(),
    ]);
    let config = test_config();
    let request = with_deadline(&io, 60_000);
    client_for(&io, &config, &request)
      .run_async(AsyncInput::Inline("x"), &job_options())
      .await
      .unwrap();
    assert_eq!(
      methods(&io),
      vec![
        (Method::Post, "/jobs".to_string()),
        (Method::Get, "/jobs/scrape-id-test/result".to_string()),
      ]
    );
  }

  #[tokio::test]
  async fn cancels_accepted_work_when_polling_fails() {
    let io = FakeIo::new(vec![
      accepted(),
      Reply::json(500, json!({})),
      Reply::json(200, json!({})),
    ]);
    let config = test_config();
    let request = with_deadline(&io, 60_000);
    let error = client_for(&io, &config, &request)
      .run_async(AsyncInput::Inline("x"), &job_options())
      .await
      .unwrap_err();
    assert!(matches!(
      error,
      FirePdfError::Async(FallbackReason::Http5xx)
    ));
    let calls = methods(&io);
    assert_eq!(
      calls[2],
      (Method::Delete, "/jobs/scrape-id-test".to_string())
    );
    assert_eq!(io.calls()[2].timeout, Some(Duration::from_secs(2)));
  }

  #[tokio::test]
  async fn cancels_after_an_ambiguous_submit_network_failure() {
    let io = FakeIo::new(vec![
      Reply::TransportError,
      Reply::TransportError,
      Reply::json(200, json!({})),
    ]);
    let config = test_config();
    let request = with_deadline(&io, 60_000);
    let error = client_for(&io, &config, &request)
      .run_async(AsyncInput::Inline("x"), &job_options())
      .await
      .unwrap_err();
    assert!(matches!(
      error,
      FirePdfError::Async(FallbackReason::NetworkError)
    ));
    assert_eq!(
      methods(&io),
      vec![
        (Method::Post, "/jobs".to_string()),
        (Method::Post, "/jobs".to_string()),
        (Method::Delete, "/jobs/scrape-id-test".to_string()),
      ]
    );
    assert_eq!(io.sleeps(), vec![SUBMIT_TRANSIENT_RETRY_DELAY_MS]);
  }

  #[tokio::test]
  async fn retries_a_submit_transport_failure_once_then_proceeds() {
    let io = FakeIo::new(vec![
      Reply::TransportError,
      accepted(),
      done_poll(),
      result_body(),
    ]);
    let config = test_config();
    let request = with_deadline(&io, 60_000);
    client_for(&io, &config, &request)
      .run_async(AsyncInput::Inline("x"), &job_options())
      .await
      .unwrap();
    assert_eq!(io.calls()[0].body, io.calls()[1].body);
  }

  #[tokio::test]
  async fn cancels_a_2xx_submit_with_an_incompatible_body() {
    let io = FakeIo::new(vec![
      Reply::json(202, json!({"status": "who-knows"})),
      Reply::json(200, json!({})),
    ]);
    let config = test_config();
    let request = with_deadline(&io, 60_000);
    let error = client_for(&io, &config, &request)
      .run_async(AsyncInput::Inline("x"), &job_options())
      .await
      .unwrap_err();
    assert!(matches!(
      error,
      FirePdfError::Async(FallbackReason::Http5xx)
    ));
    assert_eq!(methods(&io)[1].0, Method::Delete);
  }

  #[tokio::test]
  async fn submit_failures_map_to_their_reasons_without_cancelling() {
    for (status, body, expected) in [
      (
        400,
        json!({"error": "invalid_options"}),
        FallbackReason::Http400,
      ),
      (401, json!({}), FallbackReason::Http401),
      (404, json!({}), FallbackReason::Http404),
      (410, json!({}), FallbackReason::Http410),
      (413, json!({}), FallbackReason::Http413),
      (429, json!({}), FallbackReason::Http429),
      (502, json!({}), FallbackReason::Http502),
      (
        503,
        json!({"error": "admission_rejected"}),
        FallbackReason::Http503,
      ),
      (500, json!({}), FallbackReason::Http5xx),
    ] {
      let io = FakeIo::new(vec![Reply::json(status, body)]);
      let config = test_config();
      let request = with_deadline(&io, 60_000);
      let error = client_for(&io, &config, &request)
        .run_async(AsyncInput::Inline("x"), &job_options())
        .await
        .unwrap_err();
      assert!(
        matches!(error, FirePdfError::Async(reason) if reason == expected),
        "{status}"
      );
      assert_eq!(io.calls().len(), 1, "{status} must not retry or cancel");
    }
  }

  #[tokio::test]
  async fn throws_on_a_scrape_id_conflict() {
    let io = FakeIo::new(vec![Reply::json(
      409,
      json!({"error": "scrape_id_conflict"}),
    )]);
    let config = test_config();
    let request = with_deadline(&io, 60_000);
    let error = client_for(&io, &config, &request)
      .run_async(AsyncInput::Inline("x"), &job_options())
      .await
      .unwrap_err();
    assert!(matches!(error, FirePdfError::Contract(message) if message.contains("conflict")));
    assert_eq!(io.calls().len(), 1);
  }

  #[tokio::test]
  async fn retries_once_when_a_closing_api_pod_answers_with_fastify_503() {
    let io = FakeIo::new(vec![
      Reply::json(
        503,
        json!({"error": "Service Unavailable", "message": "Service Unavailable", "statusCode": 503}),
      ),
      accepted(),
      done_poll(),
      result_body(),
    ]);
    let config = test_config();
    let request = with_deadline(&io, 60_000);
    client_for(&io, &config, &request)
      .run_async(AsyncInput::Inline("x"), &job_options())
      .await
      .unwrap();
    assert_eq!(io.sleeps()[0], SUBMIT_TRANSIENT_RETRY_DELAY_MS);
    assert_eq!(methods(&io)[1], (Method::Post, "/jobs".to_string()));
  }

  #[tokio::test]
  async fn an_unattributed_503_is_retried_once_then_fails() {
    let io = FakeIo::new(vec![
      Reply::json(503, json!({})),
      Reply::json(503, json!({})),
    ]);
    let config = test_config();
    let request = with_deadline(&io, 60_000);
    let error = client_for(&io, &config, &request)
      .run_async(AsyncInput::Inline("x"), &job_options())
      .await
      .unwrap_err();
    assert!(matches!(
      error,
      FirePdfError::Async(FallbackReason::Http503)
    ));
    assert_eq!(io.calls().len(), 2);
  }

  #[tokio::test]
  async fn terminal_polls_fail_without_cancelling() {
    for (reply, expected) in [
      (
        Reply::json(502, json!({"scrape_id": "x", "status": "failed"})),
        FallbackReason::TerminalFailed,
      ),
      (
        Reply::json(410, json!({"scrape_id": "x", "status": "expired"})),
        FallbackReason::TerminalExpired,
      ),
      (
        Reply::json(410, json!({"scrape_id": "x", "status": "cancelled"})),
        FallbackReason::TerminalCancelled,
      ),
      (
        Reply::json(
          200,
          json!({"scrape_id": "x", "status": "failed", "error_class": "OOM"}),
        ),
        FallbackReason::TerminalFailed,
      ),
    ] {
      let io = FakeIo::new(vec![accepted(), reply]);
      let config = test_config();
      let request = with_deadline(&io, 60_000);
      let error = client_for(&io, &config, &request)
        .run_async(AsyncInput::Inline("x"), &job_options())
        .await
        .unwrap_err();
      assert!(matches!(error, FirePdfError::Async(reason) if reason == expected));
      assert_eq!(io.calls().len(), 2, "a terminal job is not cancelled");
    }
  }

  #[tokio::test]
  async fn polling_times_out_after_the_caller_window_plus_buffer_and_cancels() {
    let io = FakeIo::with_responder(|call: &RecordedCall, _now: &AtomicI64| match call.method {
      Method::Post => accepted(),
      Method::Delete => Reply::json(200, json!({})),
      Method::Get => running_poll(),
    });
    let config = test_config();
    let request = with_deadline(&io, 30_000);
    let error = client_for(&io, &config, &request)
      .run_async(AsyncInput::Inline("x"), &job_options())
      .await
      .unwrap_err();
    assert!(matches!(
      error,
      FirePdfError::Async(FallbackReason::PollingTimeout)
    ));
    assert!(io.elapsed() > 30_000 + POLL_TIMEOUT_BUFFER_MS);
    assert_eq!(io.calls().last().unwrap().method, Method::Delete);
  }

  #[tokio::test]
  async fn result_failures() {
    let io = FakeIo::new(vec![accepted(), done_poll(), Reply::json(503, json!({}))]);
    let config = test_config();
    let request = with_deadline(&io, 60_000);
    let error = client_for(&io, &config, &request)
      .run_async(AsyncInput::Inline("x"), &job_options())
      .await
      .unwrap_err();
    assert!(matches!(
      error,
      FirePdfError::Async(FallbackReason::Result503)
    ));
    assert_eq!(io.calls().len(), 3, "a finished job is not cancelled");

    let io = FakeIo::new(vec![
      accepted(),
      done_poll(),
      Reply::json(409, json!({})),
      result_body(),
    ]);
    let request = with_deadline(&io, 60_000);
    let result = client_for(&io, &config, &request)
      .run_async(AsyncInput::Inline("x"), &job_options())
      .await
      .unwrap();
    assert_eq!(result.markdown, "# done");
    assert_eq!(io.sleeps().last(), Some(&POLL_FLOOR_MS));

    let io = FakeIo::new(vec![
      accepted(),
      done_poll(),
      Reply::json(409, json!({})),
      Reply::json(409, json!({})),
    ]);
    let request = with_deadline(&io, 60_000);
    let error = client_for(&io, &config, &request)
      .run_async(AsyncInput::Inline("x"), &job_options())
      .await
      .unwrap_err();
    assert!(matches!(
      error,
      FirePdfError::Async(FallbackReason::Http5xx)
    ));
  }

  #[tokio::test]
  async fn page_aware_results_must_carry_what_was_requested() {
    let config = test_config();
    for (option, reply) in [
      ("pages", json!({"markdown": "x", "blocks": []})),
      (
        "blocks",
        json!({"markdown": "x", "pages": [{"page": 1, "markdown": "x"}]}),
      ),
      ("markers", json!({"markdown": "x"})),
    ] {
      let io = FakeIo::new(vec![accepted(), done_poll(), Reply::json(200, reply)]);
      let request = with_deadline(&io, 60_000);
      let mut options = job_options();
      match option {
        "pages" => options.page_markdown = true,
        "blocks" => options.blocks = true,
        _ => options.page_markers = true,
      }
      let error = client_for(&io, &config, &request)
        .run_async(AsyncInput::Inline("x"), &options)
        .await
        .unwrap_err();
      assert!(
        matches!(error, FirePdfError::Async(FallbackReason::Http5xx)),
        "{option}"
      );
    }

    // The legacy pages alias next to blocks reads as no page markdown, which blocks-only requests tolerate.
    let io = FakeIo::new(vec![
      accepted(),
      done_poll(),
      Reply::json(
        200,
        json!({
          "markdown": "x",
          "pages": [{"page": 1, "width": 1, "height": 1, "status": "ok", "blocks": []}],
          "blocks": [{"page": 1, "width": 1, "height": 1, "status": "ok", "items": []}],
          "page_markers": true
        }),
      ),
    ]);
    let request = with_deadline(&io, 60_000);
    let mut options = job_options();
    options.blocks = true;
    options.page_markers = true;
    let result = client_for(&io, &config, &request)
      .run_async(AsyncInput::Inline("x"), &options)
      .await
      .unwrap();
    assert_eq!(result.page_markdown, None);
    assert_eq!(result.blocks.unwrap().len(), 1);
    assert_eq!(
      io.calls()[0].body.clone().unwrap()["options"],
      json!({"mode": "auto", "include_blocks": true, "pageMarkers": true})
    );
  }

  #[tokio::test]
  async fn by_reference_submits_a_page_scaled_deadline_and_is_never_cancelled() {
    let io = FakeIo::new(vec![accepted(), Reply::json(500, json!({}))]);
    let config = test_config();
    let request = with_deadline(&io, 60_000);
    let mut options = job_options();
    options.pages_estimate = 100;
    let error = client_for(&io, &config, &request)
      .run_async(
        AsyncInput::ByReference {
          gcs_uri: "gs://fire-pdf-inputs/inputs/abc.pdf",
          sha256: "ABC",
        },
        &options,
      )
      .await
      .unwrap_err();
    assert!(matches!(
      error,
      FirePdfError::Async(FallbackReason::Http5xx)
    ));
    assert_eq!(io.calls().len(), 2, "by-reference jobs keep running");
    let body = io.calls()[0].body.clone().unwrap();
    assert_eq!(body["input_gcs_uri"], "gs://fire-pdf-inputs/inputs/abc.pdf");
    assert_eq!(body["input_sha256"], "ABC");
    assert!(body.get("pdf_b64").is_none());
    assert_eq!(body["options"]["pages_estimate"], 100);
    let deadline_at = DateTime::from_timestamp_millis(T0 + 10 * 60_000 + 125_000)
      .unwrap()
      .to_rfc3339_opts(SecondsFormat::Millis, true);
    assert_eq!(body["deadline_at"], deadline_at);
  }

  #[tokio::test]
  async fn by_reference_needs_a_positive_pages_estimate() {
    let io = FakeIo::new(vec![]);
    let config = test_config();
    let request = with_deadline(&io, 60_000);
    let error = client_for(&io, &config, &request)
      .run_async(
        AsyncInput::ByReference {
          gcs_uri: "gs://b/k",
          sha256: "ab",
        },
        &job_options(),
      )
      .await
      .unwrap_err();
    assert!(matches!(error, FirePdfError::Contract(message) if message.contains("pages estimate")));
    assert!(io.calls().is_empty());
  }

  #[tokio::test]
  async fn adopted_jobs_are_polled_without_a_submit_and_never_cancelled() {
    let io = FakeIo::new(vec![done_poll(), result_body()]);
    let config = test_config();
    let request = with_deadline(&io, 60_000);
    client_for(&io, &config, &request)
      .run_async(
        AsyncInput::Adopted {
          scrape_id: "older-scrape",
          sha256: "ab",
        },
        &job_options(),
      )
      .await
      .unwrap();
    assert_eq!(
      methods(&io),
      vec![
        (Method::Get, "/jobs/older-scrape".to_string()),
        (Method::Get, "/jobs/older-scrape/result".to_string()),
      ]
    );

    let io = FakeIo::new(vec![Reply::json(500, json!({}))]);
    let request = with_deadline(&io, 60_000);
    assert!(
      client_for(&io, &config, &request)
        .run_async(
          AsyncInput::Adopted {
            scrape_id: "older-scrape",
            sha256: "ab",
          },
          &job_options(),
        )
        .await
        .is_err()
    );
    assert_eq!(io.calls().len(), 1);
  }

  #[tokio::test]
  async fn adoption_lookup_is_best_effort() {
    let config = test_config();
    let request = test_request();
    let io = FakeIo::new(vec![Reply::json(
      200,
      json!({"scrape_id": "older", "status": "running"}),
    )]);
    let adopted = client_for(&io, &config, &request)
      .lookup_adoptable("abc", &job_options())
      .await;
    assert_eq!(adopted.as_deref(), Some("older"));
    let call = &io.calls()[0];
    assert_eq!(call.url, "http://fire-pdf.test/jobs/lookup");
    assert_eq!(
      call.body.clone().unwrap(),
      json!({"input_sha256": "abc", "team_id": "team-x", "options": {"mode": "auto"}})
    );
    assert_eq!(call.timeout, Some(Duration::from_secs(10)));

    for reply in [
      Reply::json(404, json!({})),
      Reply::json(500, json!({"scrape_id": "x"})),
      Reply::json(200, json!({"scrape_id": ""})),
      Reply::json(200, json!({"status": "running"})),
      Reply::TransportError,
    ] {
      let io = FakeIo::new(vec![reply]);
      assert_eq!(
        client_for(&io, &config, &request)
          .lookup_adoptable("abc", &job_options())
          .await,
        None
      );
    }
  }

  /// Drives the poll loop on the virtual clock. The job runs until `done_at_ms`;
  /// a fake honoring `wait_ms` holds the request until then or until the wait elapses.
  struct PollRun {
    sleeps: Vec<i64>,
    urls: Vec<String>,
    poll_count: u32,
    seen_at_ms: i64,
  }

  async fn run_poll(
    plan: PollPlan<'_>,
    done_at_ms: Option<i64>,
    done_after_polls: Option<usize>,
    holding: impl Fn(usize) -> bool + Send + 'static,
    running_body: serde_json::Value,
  ) -> PollRun {
    let mut polls = 0usize;
    let io = FakeIo::with_responder(move |call: &RecordedCall, now: &AtomicI64| {
      polls += 1;
      let wait = call
        .url
        .split("wait_ms=")
        .nth(1)
        .and_then(|x| x.parse::<i64>().ok())
        .unwrap_or(0);
      let done_at = done_at_ms.map(|x| T0 + x);
      if holding(polls - 1)
        && wait > 0
        && let Some(done_at) = done_at
        && now.load(Ordering::SeqCst) < done_at
      {
        let next = done_at.min(now.load(Ordering::SeqCst) + wait);
        now.store(next, Ordering::SeqCst);
      }
      let done = done_at.is_some_and(|x| now.load(Ordering::SeqCst) >= x)
        || done_after_polls.is_some_and(|n| polls >= n);
      if done {
        done_poll()
      } else {
        let mut body = json!({"scrape_id": "x", "status": "running"});
        if let (Some(map), Some(extra)) = (body.as_object_mut(), running_body.as_object()) {
          map.extend(extra.clone());
        }
        Reply::json(202, body)
      }
    });
    let config = test_config();
    let request = test_request();
    let client = client_for(&io, &config, &request);
    let mut stats = PollStats::default();
    client.poll_until_terminal(&plan, &mut stats).await.unwrap();
    PollRun {
      sleeps: io.sleeps(),
      urls: io.urls(),
      poll_count: stats.poll_count,
      seen_at_ms: io.elapsed(),
    }
  }

  fn plan(pages_estimate: u32) -> PollPlan<'static> {
    PollPlan {
      scrape_id: "x",
      initial_delay: None,
      pages_estimate,
      long_poll_wait_ms: 0,
      polling_deadline: T0 + 10 * 60_000,
      job_deadline_at_ms: None,
    }
  }

  fn repeat(ms: i64, n: usize) -> Vec<i64> {
    vec![ms; n]
  }

  fn wait_param(url: &str) -> Option<&str> {
    url.split("wait_ms=").nth(1)
  }

  #[tokio::test]
  async fn early_poll_lands_at_the_expected_finish_then_runs_fast_through_the_tail() {
    let run = run_poll(plan(3), Some(6_000), None, |_| false, json!({})).await;
    let mut expected = vec![1_200];
    expected.extend(repeat(300, 13));
    expected.push(1_000);
    assert_eq!(run.sleeps, expected);
    assert_eq!(run.poll_count, 15);

    let run = run_poll(plan(1), Some(1_000), None, |_| false, json!({})).await;
    assert_eq!(run.sleeps, vec![1_000]);
    assert_eq!(run.poll_count, 1);
  }

  #[tokio::test]
  async fn early_poll_hands_over_to_capped_backoff_past_the_tail() {
    let run = run_poll(plan(3), Some(30_000), None, |_| false, json!({})).await;
    assert_eq!(
      run.sleeps[14..20],
      [1_000, 2_000, 4_000, 5_000, 5_000, 5_000]
    );
  }

  #[tokio::test]
  async fn plain_backoff_without_a_usable_estimate() {
    let expected = vec![1_000, 2_000, 4_000, 5_000, 5_000, 5_000, 5_000];
    assert_eq!(
      run_poll(plan(0), None, Some(7), |_| false, json!({}))
        .await
        .sleeps,
      expected
    );
    assert_eq!(
      run_poll(plan(400), None, Some(7), |_| false, json!({}))
        .await
        .sleeps,
      expected
    );
  }

  #[tokio::test]
  async fn retry_after_hints_win_when_larger_and_are_capped() {
    let run = run_poll(
      PollPlan {
        initial_delay: Some(2_000),
        ..plan(3)
      },
      None,
      Some(3),
      |_| false,
      json!({"retry_after_ms": 1_500}),
    )
    .await;
    assert_eq!(run.sleeps, vec![2_000, 1_500, 1_500]);

    let run = run_poll(
      PollPlan {
        initial_delay: Some(30_000),
        ..plan(3)
      },
      None,
      Some(2),
      |_| false,
      json!({"retry_after_ms": 30_000}),
    )
    .await;
    assert_eq!(run.sleeps, vec![5_000, 5_000]);

    let run = run_poll(
      PollPlan {
        initial_delay: Some(30_000),
        ..plan(3)
      },
      None,
      Some(3),
      |_| false,
      json!({}),
    )
    .await;
    assert_eq!(run.sleeps, vec![5_000, 1_000, 2_000]);

    let run = run_poll(
      PollPlan {
        initial_delay: Some(100),
        ..plan(3)
      },
      None,
      Some(3),
      |_| false,
      json!({"retry_after_ms": 50}),
    )
    .await;
    assert_eq!(run.sleeps, vec![1_200, 300, 300]);
  }

  #[tokio::test]
  async fn caps_the_number_of_fast_polls() {
    let run = run_poll(plan(100), None, Some(40), |_| false, json!({})).await;
    assert_eq!(run.sleeps[0], 11_800);
    assert_eq!(run.sleeps[1..31], repeat(300, 30)[..]);
    assert_eq!(
      run.sleeps[31..37],
      [1_000, 2_000, 4_000, 5_000, 5_000, 5_000]
    );
  }

  #[tokio::test]
  async fn pulls_polls_in_to_land_just_after_the_job_deadline() {
    let run = run_poll(
      PollPlan {
        job_deadline_at_ms: Some(T0 + 8_000),
        ..plan(3)
      },
      None,
      Some(20),
      |_| false,
      json!({}),
    )
    .await;
    assert_eq!(run.sleeps[14..18], [1_000, 2_000, 1_000, 1_000]);
  }

  fn long_poll(wait_ms: i64) -> PollPlan<'static> {
    PollPlan {
      long_poll_wait_ms: wait_ms,
      ..plan(0)
    }
  }

  #[tokio::test]
  async fn long_poll_is_sent_at_once_and_sees_completion_when_it_happens() {
    let run = run_poll(
      long_poll(20_000),
      Some(2_500),
      None,
      |_| true,
      json!({"retry_after_ms": 250}),
    )
    .await;
    assert!(run.sleeps.is_empty());
    assert_eq!(
      run.urls.iter().map(|u| wait_param(u)).collect::<Vec<_>>(),
      vec![Some("20000")]
    );
    assert_eq!(run.poll_count, 1);
    assert_eq!(run.seen_at_ms, 2_500);

    let run = run_poll(
      long_poll(0),
      Some(2_500),
      None,
      |_| true,
      json!({"retry_after_ms": 250}),
    )
    .await;
    assert!(run.urls.iter().all(|u| wait_param(u).is_none()));
    assert!(!run.sleeps.is_empty());
  }

  #[tokio::test]
  async fn long_poll_repolls_immediately_after_a_held_request_times_out() {
    let run = run_poll(
      long_poll(20_000),
      Some(45_000),
      None,
      |_| true,
      json!({"retry_after_ms": 250}),
    )
    .await;
    assert!(run.sleeps.is_empty());
    assert_eq!(run.urls.len(), 3);
    assert!(run.urls.iter().all(|u| wait_param(u) == Some("20000")));
    assert_eq!(run.seen_at_ms, 45_000);
  }

  #[tokio::test]
  async fn long_poll_falls_back_to_the_schedule_when_the_server_never_holds() {
    let run = run_poll(
      PollPlan {
        pages_estimate: 3,
        ..long_poll(20_000)
      },
      Some(4_000),
      None,
      |_| false,
      json!({"retry_after_ms": 250}),
    )
    .await;
    assert_eq!(
      run.urls[..2]
        .iter()
        .map(|u| wait_param(u))
        .collect::<Vec<_>>(),
      vec![Some("20000"), Some("20000")]
    );
    assert!(run.urls[2..].iter().all(|u| wait_param(u).is_none()));
    assert_eq!(run.sleeps[0], 1_000);
    assert_eq!(run.sleeps.len(), run.urls.len() - 1);
    assert!(run.sleeps.iter().all(|ms| *ms >= 250));
    assert!(run.seen_at_ms >= 4_000);
  }

  #[tokio::test]
  async fn long_poll_survives_a_single_early_answer() {
    let run = run_poll(
      long_poll(20_000),
      Some(30_000),
      None,
      |i| i != 0,
      json!({"retry_after_ms": 250}),
    )
    .await;
    assert!(run.urls.iter().all(|u| wait_param(u) == Some("20000")));
    assert_eq!(run.sleeps, vec![1_000]);
    assert_eq!(run.seen_at_ms, 30_000);
  }

  #[tokio::test]
  async fn long_poll_wait_is_sized_against_the_polling_deadline() {
    let run = run_poll(
      PollPlan {
        polling_deadline: T0 + 10_000,
        ..long_poll(20_000)
      },
      Some(5_000),
      None,
      |i| i != 0,
      json!({"retry_after_ms": 250}),
    )
    .await;
    assert_eq!(
      run.urls.iter().map(|u| wait_param(u)).collect::<Vec<_>>(),
      vec![Some("9000"), Some("8000")]
    );
    assert_eq!(run.sleeps, vec![1_000]);

    let run = run_poll(
      PollPlan {
        polling_deadline: T0 + 2_500,
        ..long_poll(20_000)
      },
      Some(1_000),
      None,
      |_| false,
      json!({"retry_after_ms": 250}),
    )
    .await;
    assert_eq!(
      run.urls.iter().map(|u| wait_param(u)).collect::<Vec<_>>(),
      vec![Some("1500"), None]
    );
    assert_eq!(run.sleeps, vec![1_000]);
    assert!(run.seen_at_ms <= 2_500);

    let run = run_poll(
      PollPlan {
        polling_deadline: T0 + 8_000,
        ..long_poll(20_000)
      },
      Some(3_000),
      None,
      |_| true,
      json!({"retry_after_ms": 250}),
    )
    .await;
    assert_eq!(wait_param(&run.urls[0]), Some("7000"));
  }

  #[tokio::test]
  async fn long_poll_caps_a_large_hint_in_the_early_answer_pause() {
    let run = run_poll(
      long_poll(20_000),
      None,
      Some(2),
      |_| false,
      json!({"retry_after_ms": 30_000}),
    )
    .await;
    assert_eq!(run.sleeps, vec![5_000]);
  }
}
