//! Prefetch worker loop orchestration, service traits, bounded fire-and-forget
//! heartbeat client, and ZDR-protected per-job publish spans.

use std::collections::VecDeque;
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{Semaphore, watch};
use tokio::time::Instant;
use tracing::Instrument;

use crate::nuq_prefetch::amqp::{AmqpPrefetchPublisher, PublishError};
use crate::nuq_prefetch::config::{RedactedString, redact_http_url};
use crate::nuq_prefetch::job::{NuqJob, QueueKind};
use crate::nuq_prefetch::pg::{
  FailedJobNotification, PgStore, PoolMetrics, PrefetchBatch, StoreError,
};

/// Default polling interval matching `setTimeout(resolve, 250)` in `nuq-prefetch-worker.ts`.
pub const DEFAULT_POLL_INTERVAL: Duration = Duration::from_millis(250);

/// Maximum backoff applied after consecutive transient store errors.
pub const MAX_ERROR_BACKOFF: Duration = Duration::from_secs(5);

const HEARTBEAT_REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const HEARTBEAT_CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_PENDING_FAILURE_NOTIFICATIONS: usize = 1_024;
/// Matches the 60s listen-queue `x-expires` TTL with margin so pending waiter
/// notifications survive transient broker outages without lingering forever.
const MAX_PENDING_FAILURE_AGE: Duration = Duration::from_secs(90);
/// Per-entry retry cap applied only once another send proves the broker is up,
/// so a broker outage does not evict healthy pending notifications.
const MAX_POISON_NOTIFY_ATTEMPTS: u8 = 5;
const FAILURE_NOTIFY_FLUSH_BUDGET: Duration = Duration::from_secs(5);
const MAX_FAILURE_NOTIFY_ITEMS_PER_FLUSH: usize = 64;
const MAX_CONSECUTIVE_NOTIFY_ERRORS_PER_FLUSH: usize = 4;

struct PendingFailureNotification {
  notification: FailedJobNotification,
  enqueued_at: Instant,
  poison_attempts: u8,
  next_retry_at: Option<Instant>,
  retry_backoff: Duration,
}

struct FailureNotificationQueue {
  entries: VecDeque<PendingFailureNotification>,
  next_flush_at: Option<Instant>,
  backoff: Duration,
  base_backoff: Duration,
}

impl FailureNotificationQueue {
  fn new(base_backoff: Duration) -> Self {
    let effective_base = if base_backoff.is_zero() {
      DEFAULT_POLL_INTERVAL
    } else {
      base_backoff
    };
    Self {
      entries: VecDeque::new(),
      next_flush_at: None,
      backoff: effective_base,
      base_backoff: effective_base,
    }
  }

  fn is_empty(&self) -> bool {
    self.entries.is_empty()
  }

  fn is_due(&self, now: Instant) -> bool {
    self.next_flush_at.is_none_or(|due| now >= due)
  }

  fn record_flush_success(&mut self) {
    self.backoff = self.base_backoff;
    self.next_flush_at = None;
  }

  fn record_flush_error(&mut self, now: Instant) {
    let delay = self.backoff;
    self.backoff = next_error_backoff(self.backoff, self.base_backoff);
    self.next_flush_at = now.checked_add(delay);
  }
}

/// Boxed `Send` future alias used by worker dependency traits.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Persistence interface for NuQ prefetching, health checks, and pool metrics.
pub trait PrefetchStore: Send + Sync + 'static {
  fn prefetch_jobs(&self, queue: QueueKind) -> BoxFuture<'_, Result<PrefetchBatch, StoreError>>;
  fn health_check(&self) -> BoxFuture<'_, Result<bool, StoreError>>;
  fn pool_metrics(&self) -> PoolMetrics;
}

impl PrefetchStore for PgStore {
  fn prefetch_jobs(&self, queue: QueueKind) -> BoxFuture<'_, Result<PrefetchBatch, StoreError>> {
    Box::pin(PgStore::prefetch_jobs(self, queue))
  }

  fn health_check(&self) -> BoxFuture<'_, Result<bool, StoreError>> {
    Box::pin(PgStore::health_check(self))
  }

  fn pool_metrics(&self) -> PoolMetrics {
    PgStore::pool_metrics(self)
  }
}

/// Queue publisher interface for forwarding claimed jobs to RabbitMQ.
pub trait PrefetchPublisher: Send + Sync + 'static {
  /// Returns whether a downstream broker is configured to accept prefetched jobs.
  fn is_configured(&self) -> bool {
    true
  }

  fn send_job<'a>(
    &'a self,
    queue: QueueKind,
    job: &'a NuqJob,
  ) -> BoxFuture<'a, Result<(), PublishError>>;

  /// Sends a terminal `"failed"` notification to a waiter's RabbitMQ listen queue.
  fn send_job_failed<'a>(
    &'a self,
    _queue: QueueKind,
    _job_id: &'a str,
    _listen_channel_id: &'a str,
  ) -> BoxFuture<'a, Result<(), PublishError>> {
    Box::pin(async { Ok(()) })
  }

  fn shutdown(&self) -> BoxFuture<'_, ()>;
}

impl PrefetchPublisher for AmqpPrefetchPublisher {
  fn is_configured(&self) -> bool {
    AmqpPrefetchPublisher::is_configured(self)
  }

  fn send_job<'a>(
    &'a self,
    queue: QueueKind,
    job: &'a NuqJob,
  ) -> BoxFuture<'a, Result<(), PublishError>> {
    Box::pin(AmqpPrefetchPublisher::send_job(self, queue, job))
  }

  fn send_job_failed<'a>(
    &'a self,
    queue: QueueKind,
    job_id: &'a str,
    listen_channel_id: &'a str,
  ) -> BoxFuture<'a, Result<(), PublishError>> {
    Box::pin(AmqpPrefetchPublisher::send_job_failed(
      self,
      queue,
      job_id,
      listen_channel_id,
    ))
  }

  fn shutdown(&self) -> BoxFuture<'_, ()> {
    Box::pin(AmqpPrefetchPublisher::shutdown(self))
  }
}

/// Optional heartbeat client pinged on each `nuq.queue_scrape` loop iteration.
pub trait HeartbeatClient: Send + Sync + 'static {
  fn ping(&self) -> BoxFuture<'_, ()>;
}

/// Pure-Rust `reqwest` heartbeat client with strict timeouts and redacted Debug.
pub struct ReqwestHeartbeatClient {
  client: reqwest::Client,
  url: RedactedString,
}

impl fmt::Debug for ReqwestHeartbeatClient {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.debug_struct("ReqwestHeartbeatClient")
      .field("url", &redact_http_url(self.url.expose()))
      .finish()
  }
}

impl ReqwestHeartbeatClient {
  /// Builds an async HTTP client for fire-and-forget heartbeat GET requests.
  pub fn new(url: RedactedString) -> Result<Self, reqwest::Error> {
    firecrawl_core::telemetry::ensure_crypto_provider();
    let client = reqwest::Client::builder()
      .connect_timeout(HEARTBEAT_CONNECT_TIMEOUT)
      .timeout(HEARTBEAT_REQUEST_TIMEOUT)
      .build()?;
    Ok(Self { client, url })
  }
}

impl HeartbeatClient for ReqwestHeartbeatClient {
  fn ping(&self) -> BoxFuture<'_, ()> {
    Box::pin(async move {
      // Never log the heartbeat URL because it typically embeds a bearer token.
      if let Err(err) = self.client.get(self.url.expose()).send().await {
        tracing::debug!(
          module = "nuq-prefetch-worker",
          is_timeout = err.is_timeout(),
          is_connect = err.is_connect(),
          "Heartbeat request failed"
        );
      }
    })
  }
}

/// Executes one `prefetchJobs` cycle for `queue`, entering a ZDR-marked span
/// per job so ZDR jobs never emit telemetry or log payloads.
pub async fn run_prefetch_once<S, P>(
  queue: QueueKind,
  store: &S,
  publisher: &P,
) -> Result<usize, String>
where
  S: PrefetchStore,
  P: PrefetchPublisher,
{
  let mut pending_failures = FailureNotificationQueue::new(DEFAULT_POLL_INTERVAL);
  run_prefetch_cycle(queue, store, publisher, &mut pending_failures).await
}

fn enqueue_failure_notifications(
  queue: QueueKind,
  pending_failures: &mut FailureNotificationQueue,
  notifications: Vec<FailedJobNotification>,
) {
  for notification in notifications {
    if notification.listen_channel_id.is_none() {
      continue;
    }
    if pending_failures.entries.len() >= MAX_PENDING_FAILURE_NOTIFICATIONS {
      let _ = pending_failures.entries.pop_front();
      tracing::warn!(
        module = "nuq/rabbitmq",
        queue = queue.table_name(),
        limit = MAX_PENDING_FAILURE_NOTIFICATIONS,
        "Pending failure notification queue full; dropping oldest entry"
      );
    }
    pending_failures
      .entries
      .push_back(PendingFailureNotification {
        notification,
        enqueued_at: Instant::now(),
        poison_attempts: 0,
        next_retry_at: None,
        retry_backoff: pending_failures.base_backoff,
      });
  }
}

async fn flush_pending_failure_notifications<P: PrefetchPublisher>(
  queue: QueueKind,
  publisher: &P,
  pending_failures: &mut FailureNotificationQueue,
  broker_healthy_hint: bool,
  flush_budget: Duration,
) {
  let deadline = Instant::now().checked_add(flush_budget);
  let mut had_error = false;
  let mut deferred: Vec<PendingFailureNotification> = Vec::new();
  let mut failed_this_flush: Vec<PendingFailureNotification> = Vec::new();
  let mut any_succeeded = broker_healthy_hint;
  let mut attempted = 0_usize;
  let mut consecutive_errors = 0_usize;
  let initial_len = pending_failures.entries.len();

  for _ in 0..initial_len {
    let now = Instant::now();
    let remaining = deadline
      .map(|end| end.saturating_duration_since(now))
      .unwrap_or(flush_budget);
    if remaining.is_zero()
      || attempted >= MAX_FAILURE_NOTIFY_ITEMS_PER_FLUSH
      || consecutive_errors >= MAX_CONSECUTIVE_NOTIFY_ERRORS_PER_FLUSH
    {
      break;
    }
    let Some(entry) = pending_failures.entries.pop_front() else {
      break;
    };
    if entry.enqueued_at.elapsed() >= MAX_PENDING_FAILURE_AGE {
      tracing::warn!(
        module = "nuq/rabbitmq",
        queue = queue.table_name(),
        age_secs = entry.enqueued_at.elapsed().as_secs(),
        "Dropping expired NuQ job failure notification"
      );
      continue;
    }
    if entry.next_retry_at.is_some_and(|due| now < due) {
      deferred.push(entry);
      continue;
    }
    let Some(listen_channel_id) = entry.notification.listen_channel_id.as_deref() else {
      continue;
    };
    attempted = attempted.saturating_add(1);
    match tokio::time::timeout(
      remaining,
      publisher.send_job_failed(queue, &entry.notification.id, listen_channel_id),
    )
    .await
    {
      Ok(Ok(())) => {
        any_succeeded = true;
        consecutive_errors = 0;
      }
      Ok(Err(err @ PublishError::InvalidShortString(_))) => {
        tracing::warn!(
          module = "nuq/rabbitmq",
          queue = queue.table_name(),
          error = %err,
          "Dropping invalid NuQ job failure notification"
        );
      }
      Ok(Err(err)) => {
        had_error = true;
        consecutive_errors = consecutive_errors.saturating_add(1);
        tracing::warn!(
          module = "nuq/rabbitmq",
          queue = queue.table_name(),
          error = %err,
          "Failed to publish NuQ job failure notification"
        );
        failed_this_flush.push(entry);
      }
      Err(_elapsed) => {
        had_error = true;
        tracing::warn!(
          module = "nuq/rabbitmq",
          queue = queue.table_name(),
          budget_ms = u64::try_from(flush_budget.as_millis()).unwrap_or(u64::MAX),
          "NuQ job failure notification flush hit time budget; deferring remaining entries"
        );
        failed_this_flush.push(entry);
        break;
      }
    }
  }

  for entry in deferred {
    pending_failures.entries.push_back(entry);
  }

  let now = Instant::now();
  for mut entry in failed_this_flush {
    if any_succeeded {
      entry.poison_attempts = entry.poison_attempts.saturating_add(1);
      let delay = entry.retry_backoff;
      entry.retry_backoff = next_error_backoff(entry.retry_backoff, pending_failures.base_backoff);
      entry.next_retry_at = now.checked_add(delay);
    }
    if entry.poison_attempts < MAX_POISON_NOTIFY_ATTEMPTS
      && entry.enqueued_at.elapsed() < MAX_PENDING_FAILURE_AGE
    {
      tracing::warn!(
        module = "nuq/rabbitmq",
        queue = queue.table_name(),
        poison_attempts = entry.poison_attempts,
        max_poison_attempts = MAX_POISON_NOTIFY_ATTEMPTS,
        "Retaining NuQ job failure notification for retry"
      );
      // Rotate to the back so one poison entry cannot head-of-line block others.
      pending_failures.entries.push_back(entry);
    } else {
      tracing::error!(
        module = "nuq/rabbitmq",
        queue = queue.table_name(),
        poison_attempts = entry.poison_attempts,
        age_secs = entry.enqueued_at.elapsed().as_secs(),
        "Dropping NuQ job failure notification after exhausting retry policy"
      );
    }
  }

  if had_error && !any_succeeded && !pending_failures.entries.is_empty() {
    // Only apply queue-wide backoff when no send succeeded (indicating a broker
    // outage) and entries remain; isolated poison failures back off per entry.
    pending_failures.record_flush_error(now);
  } else {
    pending_failures.record_flush_success();
  }
}

async fn run_prefetch_cycle<S, P>(
  queue: QueueKind,
  store: &S,
  publisher: &P,
  pending_failures: &mut FailureNotificationQueue,
) -> Result<usize, String>
where
  S: PrefetchStore,
  P: PrefetchPublisher,
{
  let start = Instant::now();
  let result = async {
    if !publisher.is_configured() {
      tracing::warn!(
        module = "nuq/rabbitmq",
        queue = queue.table_name(),
        "NuQ sender not configured; skipping prefetch claim"
      );
      return Ok(0);
    }

    let batch = match store.prefetch_jobs(queue).await {
      Ok(batch) => batch,
      Err(err) => {
        // Best-effort flush so carried-over waiter notifications still drain
        // during a Postgres outage without blocking future claims.
        if !pending_failures.is_empty() && pending_failures.is_due(Instant::now()) {
          flush_pending_failure_notifications(
            queue,
            publisher,
            pending_failures,
            false,
            FAILURE_NOTIFY_FLUSH_BUDGET,
          )
          .await;
        }
        return Err(format!(
          "prefetch query failed for {}: {err}",
          queue.table_name()
        ));
      }
    };

    // Retain failure notifications before publishing valid jobs so a mid-batch
    // publish error never skips or drops waiter notifications for failed rows.
    enqueue_failure_notifications(queue, pending_failures, batch.failed_notifications);

    let mut sent = 0_usize;
    let mut publish_error: Option<String> = None;
    for job in &batch.jobs {
      let is_zdr = job.is_zero_data_retention();
      let span = if is_zdr {
        tracing::info_span!(
          "nuq.prefetch.send",
          queue = queue.table_name(),
          zero_data_retention = true,
        )
      } else {
        tracing::info_span!(
          "nuq.prefetch.send",
          queue = queue.table_name(),
          job_id = %job.id,
          zero_data_retention = false,
        )
      };
      if let Err(err) = publisher.send_job(queue, job).instrument(span).await {
        publish_error = Some(format!(
          "publish failed for {} after {sent}/{} jobs: {err}",
          queue.table_name(),
          batch.jobs.len()
        ));
        break;
      }
      sent = sent.saturating_add(1);
    }

    // Flush pending terminal failure notifications on their own bounded budget
    // and backoff schedule so notification errors never trigger cycle-wide
    // error backoff on job claims. A successful job publish bypasses queue-wide
    // outage backoff while per-entry poison backoffs remain respected.
    let broker_healthy_hint = sent > 0 && publish_error.is_none();
    if !pending_failures.is_empty()
      && (broker_healthy_hint || pending_failures.is_due(Instant::now()))
    {
      flush_pending_failure_notifications(
        queue,
        publisher,
        pending_failures,
        broker_healthy_hint,
        FAILURE_NOTIFY_FLUSH_BUDGET,
      )
      .await;
    }

    if let Some(err) = publish_error {
      return Err(err);
    }
    if let Some(repair_err) = batch.repair_error {
      return Err(format!(
        "decode repair failed for {}: {repair_err}",
        queue.table_name()
      ));
    }

    tracing::info!(
      module = "nuq/metrics",
      queue = queue.table_name(),
      job_count = batch.jobs.len(),
      "Prefetched jobs"
    );

    Ok(batch.jobs.len())
  }
  .await;

  let duration_ms = u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX);
  tracing::info!(
    module = "nuq/metrics",
    method = "nuqPrefetchJobs",
    queue = queue.table_name(),
    duration_ms,
    "nuqPrefetchJobs metrics"
  );

  result
}

/// Runs both concurrent prefetch loops (`nuq.queue_crawl_finished` and
/// `nuq.queue_scrape` with optional fire-and-forget heartbeat) until `shutdown`
/// flips to `true`, finishing any in-flight batch before returning.
pub async fn run_prefetch_loops<S, P, H>(
  store: Arc<S>,
  publisher: Arc<P>,
  heartbeat: Option<Arc<H>>,
  poll_interval: Duration,
  shutdown: watch::Receiver<bool>,
) where
  S: PrefetchStore,
  P: PrefetchPublisher,
  H: HeartbeatClient,
{
  let crawl_loop = run_single_queue_loop::<S, P, H>(
    QueueKind::CrawlFinished,
    Arc::clone(&store),
    Arc::clone(&publisher),
    None,
    poll_interval,
    shutdown.clone(),
  );
  let scrape_loop = run_single_queue_loop(
    QueueKind::Scrape,
    store,
    publisher,
    heartbeat,
    poll_interval,
    shutdown,
  );

  tokio::join!(crawl_loop, scrape_loop);
}

async fn run_single_queue_loop<S, P, H>(
  queue: QueueKind,
  store: Arc<S>,
  publisher: Arc<P>,
  heartbeat: Option<Arc<H>>,
  poll_interval: Duration,
  mut shutdown: watch::Receiver<bool>,
) where
  S: PrefetchStore,
  P: PrefetchPublisher,
  H: HeartbeatClient,
{
  // Bound to at most one in-flight heartbeat so a stalled endpoint never queues
  // background tasks or blocks the scrape prefetch loop.
  let heartbeat_gate = Arc::new(Semaphore::new(1));
  let mut pending_failures = FailureNotificationQueue::new(poll_interval);
  let mut backoff = poll_interval;

  while !*shutdown.borrow() {
    let sleep_duration = match run_prefetch_cycle(
      queue,
      store.as_ref(),
      publisher.as_ref(),
      &mut pending_failures,
    )
    .await
    {
      Ok(_) => {
        backoff = poll_interval;
        if publisher.is_configured()
          && let Some(hb) = heartbeat.as_ref()
          && let Ok(permit) = Arc::clone(&heartbeat_gate).try_acquire_owned()
        {
          let hb = Arc::clone(hb);
          tokio::spawn(async move {
            hb.ping().await;
            drop(permit);
          });
        }
        poll_interval
      }
      Err(err) => {
        tracing::error!(
          module = "nuq-prefetch-worker",
          queue = queue.table_name(),
          error = %err,
          "Error in prefetch loop iteration"
        );
        let delay = backoff;
        backoff = next_error_backoff(backoff, poll_interval);
        delay
      }
    };

    tokio::select! {
      () = tokio::time::sleep(sleep_duration) => {}
      res = shutdown.changed() => {
        if res.is_err() || *shutdown.borrow() {
          break;
        }
      }
    }
  }

  // Final best-effort flush for any unsent failure notifications before exit.
  if !pending_failures.is_empty() && publisher.is_configured() {
    flush_pending_failure_notifications(
      queue,
      publisher.as_ref(),
      &mut pending_failures,
      false,
      FAILURE_NOTIFY_FLUSH_BUDGET,
    )
    .await;
  }
}

/// Computes the next bounded error backoff starting from `poll_interval`.
#[must_use]
pub fn next_error_backoff(current: Duration, base: Duration) -> Duration {
  let effective_base = if base.is_zero() {
    DEFAULT_POLL_INTERVAL
  } else {
    base
  };
  let cap = MAX_ERROR_BACKOFF.max(effective_base);
  if current.is_zero() {
    effective_base
  } else {
    current.saturating_mul(2).min(cap)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  struct HangingNotifyPublisher {
    delay: Duration,
  }

  impl PrefetchPublisher for HangingNotifyPublisher {
    fn send_job<'a>(
      &'a self,
      _queue: QueueKind,
      _job: &'a NuqJob,
    ) -> BoxFuture<'a, Result<(), PublishError>> {
      Box::pin(async { Ok(()) })
    }

    fn send_job_failed<'a>(
      &'a self,
      _queue: QueueKind,
      _job_id: &'a str,
      _listen_channel_id: &'a str,
    ) -> BoxFuture<'a, Result<(), PublishError>> {
      let delay = self.delay;
      Box::pin(async move {
        tokio::time::sleep(delay).await;
        Ok(())
      })
    }

    fn shutdown(&self) -> BoxFuture<'_, ()> {
      Box::pin(async {})
    }
  }

  #[tokio::test(start_paused = true)]
  async fn flush_budget_caps_single_in_flight_notify_and_retains_entry() {
    let publisher = HangingNotifyPublisher {
      delay: Duration::from_secs(5),
    };
    let mut pending = FailureNotificationQueue::new(Duration::from_millis(50));
    enqueue_failure_notifications(
      QueueKind::Scrape,
      &mut pending,
      vec![FailedJobNotification {
        id: "hanging-1".to_owned(),
        listen_channel_id: Some("chan-hang".to_owned()),
      }],
    );

    let start = Instant::now();
    flush_pending_failure_notifications(
      QueueKind::Scrape,
      &publisher,
      &mut pending,
      false,
      Duration::from_millis(80),
    )
    .await;

    // Under paused Tokio time, the flush cancels at exactly the 80ms budget.
    assert_eq!(start.elapsed(), Duration::from_millis(80));
    // Timed-out notification stays queued with independent backoff scheduled.
    assert_eq!(pending.entries.len(), 1);
    assert!(pending.next_flush_at.is_some());
  }
}
