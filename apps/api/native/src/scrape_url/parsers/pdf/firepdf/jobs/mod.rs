//! fire-pdf's async job protocol: `POST /jobs`, poll `GET /jobs/:id`, fetch
//! `GET /jobs/:id/result`, cancel with `DELETE /jobs/:id`, and adopt an existing
//! job through `POST /jobs/lookup`.

use chrono::{DateTime, SecondsFormat};
use tracing::{Span, field::Empty};

use self::{
  poll::PollPlan,
  result::{AbandonGuard, JobProgress},
};
use super::{
  FallbackReason, FirePdfClient, FirePdfError, FirePdfJobOptions, FirePdfResult, io,
  schedule::{
    MIN_ASYNC_CALLER_WINDOW_MS, POLL_TIMEOUT_BUFFER_MS, compute_by_reference_deadline_ms,
    compute_deadline_ms, compute_inline_job_deadline_ms,
  },
  schema::{OcrDocument, Provenance, SubmitInputWire},
  sha256_hex,
};

mod adopt;
mod poll;
mod result;
mod submit;

/// What an async attempt hands fire-pdf.
pub enum AsyncInput<'a> {
  /// Base64 PDF in the submit body.
  Inline(&'a str),
  /// A PDF already placed in fire-pdf's input bucket.
  ByReference { gcs_uri: &'a str, sha256: &'a str },
  /// A live or finished job for the same bytes and options, found by content lookup.
  Adopted { scrape_id: &'a str, sha256: &'a str },
}

impl AsyncInput<'_> {
  fn kind(&self) -> &'static str {
    match self {
      Self::Inline(_) => "inline",
      Self::ByReference { .. } => "by_reference",
      Self::Adopted { .. } => "adopted",
    }
  }
}

/// One job's identity and deadlines, fixed before anything is sent.
struct JobPlan<'a> {
  job_scrape_id: &'a str,
  /// What goes on the wire for the submit; `None` for an adopted job, which is only watched.
  wire_input: Option<SubmitInputWire<'a>>,
  is_inline: bool,
  cache_key: String,
  deadline_at: String,
  job_deadline_at_ms: i64,
  polling_deadline: i64,
  submit_time: i64,
}

impl FirePdfClient<'_> {
  /// One async attempt: submit (unless adopting), poll until terminal, fetch the result.
  #[tracing::instrument(
    name = "FirePdfClient::run_async",
    skip_all,
    fields(
      fire_pdf.input = input.kind(),
      fire_pdf.pages_estimate = options.pages_estimate,
      fire_pdf.job_scrape_id = Empty,
      fire_pdf.deadline_at = Empty,
      fire_pdf.cache_key = Empty,
      fire_pdf.fallback_reason = Empty,
      fire_pdf.abandoned_phase = Empty,
      fire_pdf.pages_processed = Empty,
      fire_pdf.markdown_length = Empty,
      fire_pdf.page_markdown_pages = Empty,
      fire_pdf.block_pages = Empty,
      fire_pdf.failed_pages = Empty,
      fire_pdf.partial_pages = Empty,
      fire_pdf.duration_ms = Empty,
      fire_pdf.provenance = Empty,
      fire_pdf.provenance_issue = Empty,
      fire_pdf.generation = Empty,
      fire_pdf.build_sha = Empty,
    ),
    err
  )]
  pub async fn run_async(
    &self,
    input: AsyncInput<'_>,
    options: &FirePdfJobOptions,
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
    let result = self.run_job(&input, options).await;
    if let Err(FirePdfError::Async(reason)) = &result {
      Span::current().record("fire_pdf.fallback_reason", reason.as_str());
    }
    result
  }

  async fn run_job(
    &self,
    input: &AsyncInput<'_>,
    options: &FirePdfJobOptions,
  ) -> Result<FirePdfResult, FirePdfError> {
    let remaining_ms = self.remaining_ms();
    if remaining_ms.is_some_and(|x| x < MIN_ASYNC_CALLER_WINDOW_MS) {
      return Err(FirePdfError::Async(FallbackReason::DeadlineTooClose));
    }
    let plan = self.plan_job(input, options, remaining_ms)?;
    let span = Span::current();
    span.record("fire_pdf.job_scrape_id", plan.job_scrape_id);
    span.record("fire_pdf.cache_key", plan.cache_key.as_str());
    if plan.wire_input.is_some() {
      span.record("fire_pdf.deadline_at", plan.deadline_at.as_str());
    }
    let (document, poll_pages) = self.drive_job(&plan, options).await?;
    finish_job(document, poll_pages, options, &plan).await
  }

  /// This attempt polls for the caller's window. An inline job's deadline sits inside
  /// it; a by-reference job outlives its caller on purpose, so a retry converges on its result.
  fn plan_job<'a>(
    &'a self,
    input: &AsyncInput<'a>,
    options: &FirePdfJobOptions,
    remaining_ms: Option<i64>,
  ) -> Result<JobPlan<'a>, FirePdfError> {
    let own_id = self.request.scrape_id.as_str();
    let (job_scrape_id, wire_input, cache_key) = match *input {
      AsyncInput::Inline(pdf_b64) => (
        own_id,
        Some(SubmitInputWire::Inline { pdf_b64 }),
        sha256_hex(pdf_b64.as_bytes()),
      ),
      AsyncInput::ByReference { gcs_uri, sha256 } => (
        own_id,
        Some(SubmitInputWire::ByReference {
          input_gcs_uri: gcs_uri,
          input_sha256: sha256,
        }),
        format!("raw-{}", sha256.to_lowercase()),
      ),
      AsyncInput::Adopted { scrape_id, sha256 } => {
        (scrape_id, None, format!("raw-{}", sha256.to_lowercase()))
      }
    };
    let submit_time = io::now_ms();
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
    Ok(JobPlan {
      job_scrape_id,
      wire_input,
      is_inline: matches!(input, AsyncInput::Inline(_)),
      cache_key,
      deadline_at,
      job_deadline_at_ms,
      polling_deadline: submit_time + caller_window_ms + POLL_TIMEOUT_BUFFER_MS,
      submit_time,
    })
  }

  /// Submits, polls and fetches. Only an abandoned inline job is cancelled: an adopted
  /// job is not ours, and a by-reference job finishes into the content cache for the retry.
  async fn drive_job(
    &self,
    plan: &JobPlan<'_>,
    options: &FirePdfJobOptions,
  ) -> Result<(OcrDocument, Option<u32>), FirePdfError> {
    let phase = if plan.wire_input.is_some() {
      "submit"
    } else {
      "poll"
    };
    let cancel = plan
      .is_inline
      .then(|| self.cancel_request(plan.job_scrape_id));
    let mut guard = AbandonGuard::new(phase, cancel);
    let mut progress = JobProgress::default();
    let attempt = self
      .drive_steps(plan, options, &mut guard, &mut progress)
      .await;

    let (error, maybe_accepted) = match attempt {
      Ok(done) => {
        guard.disarm();
        return Ok(done);
      }
      Err(failure) => failure,
    };
    let job_already_terminal =
      matches!(&error, FirePdfError::Async(reason) if reason.is_terminal());
    if plan.is_inline
      && (progress.submission_accepted || maybe_accepted)
      && !progress.terminal_reached
      && !job_already_terminal
    {
      self.cancel_job(plan.job_scrape_id).await;
    }
    // Disarmed after the cancel, so a drop while it is in flight hands the cancel to the guard.
    guard.disarm();
    Err(error)
  }

  /// The error carries whether the submit may have been accepted without a valid answer.
  async fn drive_steps(
    &self,
    plan: &JobPlan<'_>,
    options: &FirePdfJobOptions,
    guard: &mut AbandonGuard,
    progress: &mut JobProgress,
  ) -> Result<(OcrDocument, Option<u32>), (FirePdfError, bool)> {
    let (already_done, initial_delay) = match &plan.wire_input {
      None => (false, None),
      Some(wire) => {
        let submit = self
          .submit_job(wire, options, &plan.deadline_at)
          .await
          .map_err(|f| (f.error, f.maybe_accepted))?;
        progress.submission_accepted = true;
        (submit.already_done, submit.retry_after_ms)
      }
    };
    progress.terminal_reached = already_done;

    guard.phase = "poll";
    let poll_pages = if already_done {
      None
    } else {
      let poll_plan = PollPlan {
        scrape_id: plan.job_scrape_id,
        initial_delay,
        pages_estimate: options.pages_estimate,
        long_poll_wait_ms: self.config.async_wait_ms,
        polling_deadline: plan.polling_deadline,
        job_deadline_at_ms: plan.is_inline.then_some(plan.job_deadline_at_ms),
      };
      self
        .poll_until_terminal(&poll_plan)
        .await
        .map_err(|e| (e, false))?
    };
    progress.terminal_reached = true;

    guard.phase = "result";
    guard.cancel = None;
    let fetched = self
      .fetch_result(plan.job_scrape_id)
      .await
      .map_err(|e| (e, false))?;
    Ok((fetched, poll_pages))
  }
}

/// Checks the result carries what was asked for and records it on the `run_async` span.
async fn finish_job(
  document: OcrDocument,
  poll_pages: Option<u32>,
  options: &FirePdfJobOptions,
  plan: &JobPlan<'_>,
) -> Result<FirePdfResult, FirePdfError> {
  // Markers are baked into the markdown, so the echo is the only proof the worker honored them.
  if (options.page_markdown && document.pages.is_none())
    || (options.blocks && document.blocks.is_none())
    || (options.page_markers && document.page_markers != Some(true))
  {
    return Err(FirePdfError::Async(FallbackReason::Http5xx));
  }

  let pages_processed = document
    .pages_processed
    .or(poll_pages)
    .unwrap_or(options.pages_estimate);
  let span = Span::current();
  span.record("fire_pdf.pages_processed", pages_processed);
  span.record("fire_pdf.markdown_length", document.markdown.len());
  span.record(
    "fire_pdf.page_markdown_pages",
    document.pages.as_ref().map(Vec::len),
  );
  span.record(
    "fire_pdf.block_pages",
    document.blocks.as_ref().map(Vec::len),
  );
  span.record(
    "fire_pdf.failed_pages",
    document.failed_pages.as_ref().map_or(0, Vec::len),
  );
  span.record(
    "fire_pdf.partial_pages",
    document.partial_pages.as_ref().map_or(0, Vec::len),
  );
  span.record("fire_pdf.duration_ms", io::now_ms() - plan.submit_time);
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
