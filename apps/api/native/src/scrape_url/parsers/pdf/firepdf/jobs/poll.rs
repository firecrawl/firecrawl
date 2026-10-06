//! `GET /jobs/:id` until the job is terminal, on the page-aware early schedule,
//! exponential backoff, or `wait_ms` long-polls.

use serde_json::Value;
use tracing::{Span, field::Empty};

use super::super::{
  FallbackReason, FirePdfClient, FirePdfError,
  io::{self, Method},
  schedule::{
    EarlyPollState, LONG_POLL_HELD_FRACTION, LONG_POLL_MAX_EARLY_ANSWERS, POLL_CAP_MS,
    POLL_FLOOR_MS, align_poll_delay, early_poll_delay, long_poll_wait_for, next_poll_delay,
  },
  schema::{JobStatus, PollResponse},
};

pub(super) struct PollPlan<'a> {
  pub scrape_id: &'a str,
  /// fire-pdf's `retry_after_ms` from the submit response.
  pub initial_delay: Option<i64>,
  /// Selects the page-aware early schedule; 0 keeps plain backoff.
  pub pages_estimate: u32,
  pub long_poll_wait_ms: i64,
  pub polling_deadline: i64,
  /// Only an inline job's own deadline sits inside this caller's window.
  pub job_deadline_at_ms: Option<i64>,
}

/// One poll's answer.
enum PollAnswer {
  Running(PollResponse),
  /// The job is done; fire-pdf's `pages_processed`, when it sent one.
  Done(Option<u32>),
}

/// What decided the timing of one poll.
struct Round {
  /// `wait_ms` sent with the poll; 0 for a scheduled poll.
  wait_ms: i64,
  /// The early schedule's delay, when it chose this poll's timing.
  early: Option<i64>,
}

#[derive(Default)]
struct PollStats {
  poll_count: u32,
  long_poll_terminal: u32,
  long_poll_held: u32,
  long_poll_not_held: u32,
  last_status: Option<&'static str>,
  terminal_status: Option<&'static str>,
}

struct PollLoop<'a> {
  plan: &'a PollPlan<'a>,
  started_at: i64,
  last_delay: i64,
  retry_after_ms: Option<i64>,
  fast_poll_count: u32,
  in_early_schedule: bool,
  /// Cleared for the rest of the job after repeated early answers to `wait_ms`.
  long_poll_active: bool,
  early_answers: u32,
  stats: PollStats,
}

impl<'a> PollLoop<'a> {
  fn new(plan: &'a PollPlan<'a>) -> Self {
    Self {
      plan,
      started_at: io::now_ms(),
      last_delay: next_poll_delay(0, plan.initial_delay, io::random()),
      retry_after_ms: plan.initial_delay,
      fast_poll_count: 0,
      in_early_schedule: false,
      long_poll_active: plan.long_poll_wait_ms > 0,
      early_answers: 0,
      stats: PollStats::default(),
    }
  }

  /// Waits until the next poll is due. After an early answer, pauses once on the floor
  /// before the next `wait_ms` request; when no long-poll would fit after it, the round
  /// takes the scheduled path. A long-poll is sent right away: the server does the waiting.
  async fn next_round(&mut self) -> Result<Round, FirePdfError> {
    let plan = self.plan;
    let mut scheduled_this_round = false;
    if self.long_poll_active && self.early_answers > 0 {
      let pause_ms = POLL_FLOOR_MS.max(POLL_CAP_MS.min(self.retry_after_ms.unwrap_or(0)));
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
      return Err(FirePdfError::Async(FallbackReason::PollingTimeout));
    }
    let wait_ms = if self.long_poll_active && !scheduled_this_round {
      long_poll_wait_for(plan.long_poll_wait_ms, plan.polling_deadline - io::now_ms())
    } else {
      0
    };
    let early = if wait_ms == 0 {
      self.scheduled_sleep().await
    } else {
      None
    };
    Ok(Round { wait_ms, early })
  }

  /// Sleeps on the early schedule or the backoff, never past the polling deadline.
  async fn scheduled_sleep(&mut self) -> Option<i64> {
    let plan = self.plan;
    let early = early_poll_delay(&EarlyPollState {
      pages_estimate: plan.pages_estimate,
      elapsed_ms: io::now_ms() - self.started_at,
      poll_count: self.stats.poll_count,
      fast_poll_count: self.fast_poll_count,
      retry_after_ms: self.retry_after_ms,
      random: io::random(),
    });
    if early.is_some() && self.stats.poll_count > 0 {
      self.fast_poll_count += 1;
    }
    if early.is_some() {
      self.in_early_schedule = true;
    } else if self.in_early_schedule {
      // Handover: backoff restarts from the floor (or the latest hint).
      self.in_early_schedule = false;
      self.last_delay = next_poll_delay(0, self.retry_after_ms, io::random());
    }
    let delay = align_poll_delay(
      early.unwrap_or(self.last_delay),
      io::now_ms(),
      plan.job_deadline_at_ms,
    )
    .min((plan.polling_deadline - io::now_ms()).max(0));
    io::sleep(delay).await;
    early
  }

  fn terminal(&mut self, round: &Round, status: &'static str) {
    if round.wait_ms > 0 {
      self.stats.long_poll_terminal += 1;
    }
    self.stats.terminal_status = Some(status);
  }

  fn interpret(
    &mut self,
    round: &Round,
    status: u16,
    body: Value,
  ) -> Result<PollAnswer, FirePdfError> {
    let parsed = serde_json::from_value::<PollResponse>(body);
    let reason = match status {
      200 | 202 => None,
      401 => Some(FallbackReason::Http401),
      404 => {
        return Err(FirePdfError::Contract(
          "fire-pdf async GET /jobs/:id 404: scrape_id missing after successful submit",
        ));
      }
      410 => {
        let job_status = parsed.as_ref().map_or(JobStatus::Expired, |x| x.status);
        self.terminal(round, job_status.as_str());
        Some(if job_status == JobStatus::Cancelled {
          FallbackReason::TerminalCancelled
        } else {
          FallbackReason::TerminalExpired
        })
      }
      502 => {
        self.terminal(round, "failed");
        Some(FallbackReason::TerminalFailed)
      }
      _ => Some(FallbackReason::Http5xx),
    };
    if let Some(reason) = reason {
      return Err(FirePdfError::Async(reason));
    }
    let poll = parsed.map_err(|_| FirePdfError::Async(FallbackReason::Http5xx))?;
    if !poll.status.is_terminal() {
      self.stats.last_status = Some(poll.status.as_str());
      return Ok(PollAnswer::Running(poll));
    }
    self.terminal(round, poll.status.as_str());
    if let Some(error_class) = poll.error_class.as_deref() {
      Span::current().record("fire_pdf.error_class", error_class);
    }
    match poll.status {
      JobStatus::Failed => Err(FirePdfError::Async(FallbackReason::TerminalFailed)),
      JobStatus::Expired => Err(FirePdfError::Async(FallbackReason::TerminalExpired)),
      JobStatus::Cancelled => Err(FirePdfError::Async(FallbackReason::TerminalCancelled)),
      _ => Ok(PollAnswer::Done(poll.pages_processed)),
    }
  }

  /// A non-terminal answer to a long-poll that came back early means the server did
  /// not hold it; repeated early answers put the job on the regular schedule.
  fn after_running(&mut self, round: &Round, poll: PollResponse, held_ms: i64) {
    if round.wait_ms > 0 {
      let held = held_ms as f64 >= round.wait_ms as f64 * LONG_POLL_HELD_FRACTION;
      if held {
        self.stats.long_poll_held += 1;
        self.early_answers = 0;
      } else {
        self.stats.long_poll_not_held += 1;
        self.early_answers += 1;
      }
      if self.early_answers >= LONG_POLL_MAX_EARLY_ANSWERS {
        self.long_poll_active = false;
      }
    }
    self.retry_after_ms = poll.retry_after_ms;
    // Backoff advances only while it is the schedule in use.
    if round.wait_ms == 0 && round.early.is_none() {
      self.last_delay = next_poll_delay(self.last_delay, self.retry_after_ms, io::random());
    }
  }

  fn record(&self, span: &Span) {
    span.record("fire_pdf.poll_count", self.stats.poll_count);
    span.record("fire_pdf.long_poll.terminal", self.stats.long_poll_terminal);
    span.record("fire_pdf.long_poll.held", self.stats.long_poll_held);
    span.record("fire_pdf.long_poll.not_held", self.stats.long_poll_not_held);
    span.record("fire_pdf.last_status", self.stats.last_status);
    span.record("fire_pdf.terminal_status", self.stats.terminal_status);
  }
}

impl FirePdfClient<'_> {
  /// Polls until the job is terminal. `Ok` carries fire-pdf's `pages_processed` when it sent one.
  #[tracing::instrument(
    name = "FirePdfClient::poll_until_terminal",
    skip_all,
    fields(
      fire_pdf.job_scrape_id = plan.scrape_id,
      fire_pdf.long_poll.wait_ms = plan.long_poll_wait_ms,
      fire_pdf.poll_count = Empty,
      fire_pdf.long_poll.terminal = Empty,
      fire_pdf.long_poll.held = Empty,
      fire_pdf.long_poll.not_held = Empty,
      fire_pdf.last_status = Empty,
      fire_pdf.terminal_status = Empty,
      fire_pdf.error_class = Empty,
      fire_pdf.transport_error = Empty,
      http.status = Empty,
    ),
    err
  )]
  pub(super) async fn poll_until_terminal(
    &self,
    plan: &PollPlan<'_>,
  ) -> Result<Option<u32>, FirePdfError> {
    let mut state = PollLoop::new(plan);
    let outcome = self.poll_loop(&mut state).await;
    state.record(&Span::current());
    outcome
  }

  async fn poll_loop(&self, state: &mut PollLoop<'_>) -> Result<Option<u32>, FirePdfError> {
    let span = Span::current();
    loop {
      let round = state.next_round().await?;
      state.stats.poll_count += 1;
      let url = if round.wait_ms > 0 {
        format!(
          "{}/jobs/{}?wait_ms={}",
          self.base_url, state.plan.scrape_id, round.wait_ms
        )
      } else {
        format!("{}/jobs/{}", self.base_url, state.plan.scrape_id)
      };
      let sent_at = io::now_ms();
      let response = self
        .send(Method::Get, url, None, None)
        .await
        .map_err(|error| {
          span.record("fire_pdf.transport_error", error.as_str());
          FirePdfError::Async(FallbackReason::NetworkError)
        })?;
      span.record("http.status", response.status);
      match state.interpret(&round, response.status, response.json_or_empty())? {
        PollAnswer::Done(pages_processed) => return Ok(pages_processed),
        PollAnswer::Running(poll) => state.after_running(&round, poll, io::now_ms() - sent_at),
      }
    }
  }
}
