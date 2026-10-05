//! fire-pdf's async job protocol: `POST /jobs`, poll `GET /jobs/:id`, fetch
//! `GET /jobs/:id/result`, cancel with `DELETE /jobs/:id`, and adopt an existing
//! job through `POST /jobs/lookup`.

use std::time::Duration;

use chrono::{DateTime, SecondsFormat};
use serde_json::Value;
use tracing::{Instrument, Span, field::Empty};

use super::{
  FallbackReason, FirePdfClient, FirePdfError, FirePdfJobOptions, FirePdfResult,
  io::{self, HttpRequest, Method},
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

impl FirePdfClient<'_> {
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

    let submit_time = io::now_ms();
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
    let duration_ms = io::now_ms() - submit_time;
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
      io::sleep(SUBMIT_TRANSIENT_RETRY_DELAY_MS).await;
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
    let mut last_delay = next_poll_delay(0, plan.initial_delay, io::random());
    let started_at = io::now_ms();
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
          plan.polling_deadline - io::now_ms() - pause_ms,
        ) > 0;
        if fits_after_pause {
          io::sleep(pause_ms).await;
        } else {
          scheduled_this_round = true;
        }
      }
      if io::now_ms() >= plan.polling_deadline {
        return Err(fail_async(
          FallbackReason::PollingTimeout,
          &format!("poll_count={}", stats.poll_count),
        ));
      }

      let wait_ms = if long_poll_active && !scheduled_this_round {
        long_poll_wait_for(plan.long_poll_wait_ms, plan.polling_deadline - io::now_ms())
      } else {
        0
      };
      // A long-poll is sent right away: the server does the waiting.
      let mut early = None;
      if wait_ms == 0 {
        early = early_poll_delay(&EarlyPollState {
          pages_estimate: plan.pages_estimate,
          elapsed_ms: io::now_ms() - started_at,
          poll_count: stats.poll_count,
          fast_poll_count,
          retry_after_ms,
          random: io::random(),
        });
        if early.is_some() && stats.poll_count > 0 {
          fast_poll_count += 1;
        }
        if early.is_some() {
          in_early_schedule = true;
        } else if in_early_schedule {
          // Handover: backoff restarts from the floor (or the latest hint).
          in_early_schedule = false;
          last_delay = next_poll_delay(0, retry_after_ms, io::random());
        }
        // Never sleep past the polling deadline: the next round times out on schedule.
        let delay = align_poll_delay(
          early.unwrap_or(last_delay),
          io::now_ms(),
          plan.job_deadline_at_ms,
        )
        .min((plan.polling_deadline - io::now_ms()).max(0));
        io::sleep(delay).await;
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
      let sent_at = io::now_ms();
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
        let held = (io::now_ms() - sent_at) as f64 >= wait_ms as f64 * LONG_POLL_HELD_FRACTION;
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
        last_delay = next_poll_delay(last_delay, retry_after_ms, io::random());
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
          io::sleep(POLL_FLOOR_MS).await;
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
