//! Deadline math and poll cadence for fire-pdf async jobs. Pure, so the
//! schedule is testable without a clock.

/// `deadline_at - now` must fall in `[MIN_DEADLINE_MS, MAX_DEADLINE_MS]` per the /jobs contract.
pub const MIN_DEADLINE_MS: i64 = 5_000;
pub const MAX_DEADLINE_MS: i64 = 30 * 60 * 1_000;
pub const POLL_FLOOR_MS: i64 = 1_000;
pub const POLL_CAP_MS: i64 = 5_000;

/// A `wait_ms` shorter than this is not worth holding a connection for.
const LONG_POLL_MIN_WAIT_MS: i64 = 1_000;
/// fire-pdf clamps longer waits, so asking for more would make a held answer look early.
const LONG_POLL_MAX_WAIT_MS: i64 = 25_000;
const LONG_POLL_DEADLINE_SLACK_MS: i64 = 1_000;
/// A non-terminal answer faster than this fraction of `wait_ms` was not held.
pub const LONG_POLL_HELD_FRACTION: f64 = 0.5;
/// Early answers in a row after which the job stays on the regular schedule.
pub const LONG_POLL_MAX_EARLY_ANSWERS: u32 = 2;

/// Polling budget past the caller window, on top of the worker's own expiry handling.
pub const POLL_TIMEOUT_BUFFER_MS: i64 = 30_000;

/// An inline job's deadline sits this far inside the caller window, so the
/// worker's deadline-degraded result is written and fetched before the caller gives up.
const INLINE_JOB_DEADLINE_MARGIN_FRACTION: f64 = 0.1;
const INLINE_JOB_DEADLINE_MARGIN_MIN_MS: i64 = 10_000;
const INLINE_JOB_DEADLINE_MARGIN_MAX_MS: i64 = 30_000;
/// Polls are pulled forward to land this long after the job deadline.
const JOB_DEADLINE_POLL_GRACE_MS: i64 = 1_000;

pub const SUBMIT_TRANSIENT_RETRY_DELAY_MS: i64 = 250;
/// fire-pdf validates `deadline_at - now` on arrival, so the deadline must clear the minimum by the flight time.
const INLINE_SUBMIT_SLACK_MS: i64 = 5_000;
/// The smallest caller window async accepts; below it the inline job deadline would be rejected on arrival.
pub const MIN_ASYNC_CALLER_WINDOW_MS: i64 =
  MIN_DEADLINE_MS + INLINE_JOB_DEADLINE_MARGIN_MIN_MS + INLINE_SUBMIT_SLACK_MS;

/// Usable window of a scrape with no deadline.
const DEFAULT_CALLER_WINDOW_MS: i64 = 5 * 60 * 1_000;

/// Worst-case by-reference rate (scanned OCR p90) and a base that absorbs burst queue wait.
const BY_REFERENCE_DEADLINE_PER_PAGE_MS: i64 = 1_250;
const BY_REFERENCE_DEADLINE_BASE_MS: i64 = 10 * 60 * 1_000;

fn round(x: f64) -> i64 {
  x.round() as i64
}

/// Exponential backoff from the floor with +0-20% jitter, capped; fire-pdf's hint is a floor.
pub fn next_poll_delay(prev: i64, retry_after_ms: Option<i64>, random: f64) -> i64 {
  let candidate = (prev * 2)
    .max(retry_after_ms.unwrap_or(0))
    .max(POLL_FLOOR_MS);
  POLL_CAP_MS.min(round(candidate as f64 * (1.0 + random * 0.2)))
}

/// Deadline for an inline job: the caller window minus a margin, never below fire-pdf's minimum.
pub fn compute_inline_job_deadline_ms(caller_window_ms: i64) -> i64 {
  let margin = round(caller_window_ms as f64 * INLINE_JOB_DEADLINE_MARGIN_FRACTION).clamp(
    INLINE_JOB_DEADLINE_MARGIN_MIN_MS,
    INLINE_JOB_DEADLINE_MARGIN_MAX_MS,
  );
  MIN_DEADLINE_MS.max(caller_window_ms - margin)
}

/// Caps a poll delay so a poll lands just after the job deadline, and polls at the floor past it.
pub fn align_poll_delay(delay_ms: i64, now_ms: i64, job_deadline_at_ms: Option<i64>) -> i64 {
  let Some(job_deadline_at_ms) = job_deadline_at_ms else {
    return delay_ms;
  };
  let until_target = job_deadline_at_ms + JOB_DEADLINE_POLL_GRACE_MS - now_ms;
  if until_target <= 0 {
    delay_ms.min(POLL_FLOOR_MS)
  } else {
    delay_ms.min(POLL_FLOOR_MS.max(until_target))
  }
}

/// The caller window: the remaining scrape budget, or 5 minutes without one, capped at fire-pdf's maximum.
pub fn compute_deadline_ms(remaining_ms: Option<i64>) -> i64 {
  MAX_DEADLINE_MS.min(remaining_ms.unwrap_or(DEFAULT_CALLER_WINDOW_MS))
}

/// By-reference job deadline: page-scaled, never below the caller window, capped at fire-pdf's maximum.
pub fn compute_by_reference_deadline_ms(remaining_ms: Option<i64>, pages_estimate: u32) -> i64 {
  let page_scaled =
    BY_REFERENCE_DEADLINE_BASE_MS + i64::from(pages_estimate) * BY_REFERENCE_DEADLINE_PER_PAGE_MS;
  MAX_DEADLINE_MS.min(compute_deadline_ms(remaining_ms).max(page_scaled))
}

/// The `wait_ms` to send now, bounded by the polling deadline, or 0 when too little time is left.
pub fn long_poll_wait_for(configured_ms: i64, ms_until_deadline: i64) -> i64 {
  let wait = configured_ms
    .min(LONG_POLL_MAX_WAIT_MS)
    .min(ms_until_deadline - LONG_POLL_DEADLINE_SLACK_MS);
  if wait >= LONG_POLL_MIN_WAIT_MS {
    wait
  } else {
    0
  }
}

struct PipelineBucket {
  /// Inclusive upper bound of the page estimate this row applies to.
  max_pages: u32,
  /// Typical pipeline time: where the first poll lands.
  p50_ms: i64,
  /// Slow-tail pipeline time: where fast polling stops.
  p90_ms: i64,
}

const PIPELINE_BUCKETS: [PipelineBucket; 6] = [
  PipelineBucket {
    max_pages: 1,
    p50_ms: 1_000,
    p90_ms: 3_000,
  },
  PipelineBucket {
    max_pages: 5,
    p50_ms: 1_200,
    p90_ms: 5_000,
  },
  PipelineBucket {
    max_pages: 10,
    p50_ms: 2_500,
    p90_ms: 9_700,
  },
  PipelineBucket {
    max_pages: 25,
    p50_ms: 4_400,
    p90_ms: 14_900,
  },
  PipelineBucket {
    max_pages: 50,
    p50_ms: 5_200,
    p90_ms: 19_500,
  },
  PipelineBucket {
    max_pages: 100,
    p50_ms: 11_800,
    p90_ms: 31_000,
  },
];

const FAST_POLL_MS: i64 = 300;
const EARLY_POLL_JITTER: f64 = 0.2;
const MIN_EARLY_POLL_MS: i64 = 250;
/// Bounds the extra requests one job can cause, however long its tail.
const MAX_FAST_POLLS: u32 = 30;

pub struct EarlyPollState {
  pub pages_estimate: u32,
  /// Time since polling began.
  pub elapsed_ms: i64,
  /// Polls already sent (the first poll is number 0).
  pub poll_count: u32,
  /// Polls already sent on the fast interval.
  pub fast_poll_count: u32,
  /// fire-pdf's own requested delay; wins whenever it is larger.
  pub retry_after_ms: Option<i64>,
  pub random: f64,
}

/// Delay before the next poll while a job with a known page count is inside its
/// expected pipeline window, or `None` once the regular backoff takes over.
pub fn early_poll_delay(state: &EarlyPollState) -> Option<i64> {
  if state.pages_estimate == 0 {
    return None;
  }
  let bucket = PIPELINE_BUCKETS
    .iter()
    .find(|b| state.pages_estimate <= b.max_pages)?;

  let base = if state.poll_count == 0 {
    bucket.p50_ms
  } else if state.elapsed_ms < bucket.p90_ms && state.fast_poll_count < MAX_FAST_POLLS {
    FAST_POLL_MS
  } else {
    return None;
  };
  let jittered = round(base as f64 * (1.0 + state.random * EARLY_POLL_JITTER));
  let hint = POLL_CAP_MS.min(state.retry_after_ms.unwrap_or(0));
  Some(MIN_EARLY_POLL_MS.max(jittered).max(hint))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn backoff_uses_the_server_hint_as_a_floor_with_jitter() {
    assert_eq!(next_poll_delay(1_000, Some(4_500), 0.0), 4_500);
    assert_eq!(next_poll_delay(2_000, Some(1_000), 0.0), 4_000);
    assert_eq!(next_poll_delay(1_000, None, 0.5), 2_200);
    assert_eq!(next_poll_delay(4_000, None, 1.0), 5_000);
  }

  #[test]
  fn caller_deadline_is_never_inflated() {
    assert_eq!(compute_deadline_ms(Some(4_000)), 4_000);
    assert_eq!(compute_deadline_ms(None), 5 * 60 * 1_000);
    assert_eq!(compute_deadline_ms(Some(60 * 60 * 1_000)), MAX_DEADLINE_MS);
  }

  #[test]
  fn by_reference_deadline_is_page_scaled_and_decoupled_from_the_caller() {
    let ten_min = 10 * 60 * 1_000;
    assert_eq!(
      compute_by_reference_deadline_ms(Some(60_000), 100),
      ten_min + 125_000
    );
    assert_eq!(
      compute_by_reference_deadline_ms(Some(60_000), 6_543),
      30 * 60 * 1_000
    );
    assert_eq!(
      compute_by_reference_deadline_ms(Some(60_000), 931),
      ten_min + 931 * 1_250
    );
    assert_eq!(
      compute_by_reference_deadline_ms(Some(60_000), 798),
      ten_min + 798 * 1_250
    );
    assert_eq!(
      compute_by_reference_deadline_ms(Some(25 * 60 * 1_000), 100),
      25 * 60 * 1_000
    );
    assert_eq!(compute_by_reference_deadline_ms(None, 0), ten_min);
  }

  #[test]
  fn inline_job_deadline_takes_a_bounded_margin() {
    assert_eq!(compute_inline_job_deadline_ms(30_000), 20_000);
    assert_eq!(compute_inline_job_deadline_ms(60_000), 50_000);
    assert_eq!(compute_inline_job_deadline_ms(300_000), 270_000);
    assert_eq!(compute_inline_job_deadline_ms(1_800_000), 1_770_000);
    assert_eq!(compute_inline_job_deadline_ms(15_000), 5_000);
    assert_eq!(compute_inline_job_deadline_ms(1_000), 5_000);
    assert_eq!(
      compute_inline_job_deadline_ms(MIN_ASYNC_CALLER_WINDOW_MS),
      10_000
    );
  }

  #[test]
  fn align_poll_delay_targets_the_job_deadline() {
    let now = 100_000;
    assert_eq!(align_poll_delay(5_000, now, None), 5_000);
    assert_eq!(align_poll_delay(5_000, now, Some(now + 60_000)), 5_000);
    assert_eq!(align_poll_delay(5_000, now, Some(now + 2_500)), 3_500);
    assert_eq!(align_poll_delay(5_000, now, Some(now + 200)), 1_200);
    assert_eq!(align_poll_delay(5_000, now, Some(now - 500)), 1_000);
    assert_eq!(align_poll_delay(5_000, now, Some(now - 5_000)), 1_000);
  }

  #[test]
  fn long_poll_wait_is_bounded() {
    assert_eq!(long_poll_wait_for(20_000, 5 * 60_000), 20_000);
    assert_eq!(long_poll_wait_for(20_000, 6_000), 5_000);
    assert_eq!(long_poll_wait_for(60_000, 5 * 60_000), 25_000);
    assert_eq!(long_poll_wait_for(20_000, 1_500), 0);
    assert_eq!(long_poll_wait_for(0, 5 * 60_000), 0);
  }

  fn first_poll(pages: u32) -> Option<i64> {
    early_poll_delay(&EarlyPollState {
      pages_estimate: pages,
      elapsed_ms: 0,
      poll_count: 0,
      fast_poll_count: 0,
      retry_after_ms: None,
      random: 0.0,
    })
  }

  #[test]
  fn early_poll_picks_the_bucket_from_the_page_estimate() {
    assert_eq!(first_poll(1), Some(1_000));
    assert_eq!(first_poll(5), Some(1_200));
    assert_eq!(first_poll(6), Some(2_500));
    assert_eq!(first_poll(25), Some(4_400));
    assert_eq!(first_poll(50), Some(5_200));
    assert_eq!(first_poll(100), Some(11_800));
    assert_eq!(first_poll(0), None);
    assert_eq!(first_poll(101), None);
  }

  #[test]
  fn early_poll_jitters_the_fast_interval() {
    let delays: Vec<Option<i64>> = [0.0, 0.5, 0.999]
      .into_iter()
      .map(|random| {
        early_poll_delay(&EarlyPollState {
          pages_estimate: 10,
          elapsed_ms: 4_000,
          poll_count: 3,
          fast_poll_count: 0,
          retry_after_ms: None,
          random,
        })
      })
      .collect();
    assert_eq!(delays, vec![Some(300), Some(330), Some(360)]);
  }
}
