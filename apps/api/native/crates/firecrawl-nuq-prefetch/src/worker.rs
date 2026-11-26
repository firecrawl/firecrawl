//! Prefetch worker loop orchestration, service traits, bounded fire-and-forget
//! heartbeat client, and ZDR-protected per-job publish spans.

use std::collections::VecDeque;
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::{Semaphore, watch};
use tracing::Instrument;

use crate::amqp::{AmqpPrefetchPublisher, PublishError};
use crate::config::{RedactedString, redact_http_url};
use crate::job::{NuqJob, QueueKind};
use crate::pg::{FailedJobNotification, PgStore, PoolMetrics, PrefetchBatch, StoreError};

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
  let mut pending_failures = VecDeque::new();
  run_prefetch_cycle(queue, store, publisher, &mut pending_failures).await
}

fn enqueue_failure_notifications(
  queue: QueueKind,
  pending_failures: &mut VecDeque<PendingFailureNotification>,
  notifications: Vec<FailedJobNotification>,
) {
  for notification in notifications {
    if notification.listen_channel_id.is_none() {
      continue;
    }
    if pending_failures.len() >= MAX_PENDING_FAILURE_NOTIFICATIONS {
      let _ = pending_failures.pop_front();
      tracing::warn!(
        module = "nuq/rabbitmq",
        queue = queue.table_name(),
        limit = MAX_PENDING_FAILURE_NOTIFICATIONS,
        "Pending failure notification queue full; dropping oldest entry"
      );
    }
    pending_failures.push_back(PendingFailureNotification {
      notification,
      enqueued_at: Instant::now(),
      poison_attempts: 0,
    });
  }
}

async fn flush_pending_failure_notifications<P: PrefetchPublisher>(
  queue: QueueKind,
  publisher: &P,
  pending_failures: &mut VecDeque<PendingFailureNotification>,
  broker_healthy_hint: bool,
) -> Result<(), String> {
  // Prune expired entries at the front first so they never consume I/O budget.
  while let Some(front) = pending_failures.front() {
    if front.enqueued_at.elapsed() >= MAX_PENDING_FAILURE_AGE {
      if let Some(expired) = pending_failures.pop_front() {
        tracing::warn!(
          module = "nuq/rabbitmq",
          queue = queue.table_name(),
          age_secs = expired.enqueued_at.elapsed().as_secs(),
          "Dropping expired NuQ job failure notification"
        );
      }
    } else {
      break;
    }
  }

  let flush_start = Instant::now();
  let mut first_error: Option<String> = None;
  let mut failed_this_flush: Vec<PendingFailureNotification> = Vec::new();
  let mut any_succeeded = broker_healthy_hint;
  let mut attempted = 0_usize;
  let mut consecutive_errors = 0_usize;
  let max_items = pending_failures
    .len()
    .min(MAX_FAILURE_NOTIFY_ITEMS_PER_FLUSH);

  for _ in 0..max_items {
    if attempted > 0 && flush_start.elapsed() >= FAILURE_NOTIFY_FLUSH_BUDGET {
      break;
    }
    if consecutive_errors >= MAX_CONSECUTIVE_NOTIFY_ERRORS_PER_FLUSH {
      break;
    }
    let Some(entry) = pending_failures.pop_front() else {
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
    let Some(listen_channel_id) = entry.notification.listen_channel_id.as_deref() else {
      continue;
    };
    attempted = attempted.saturating_add(1);
    match publisher
      .send_job_failed(queue, &entry.notification.id, listen_channel_id)
      .await
    {
      Ok(()) => {
        any_succeeded = true;
        consecutive_errors = 0;
      }
      Err(err) => {
        consecutive_errors = consecutive_errors.saturating_add(1);
        if first_error.is_none() {
          first_error = Some(format!(
            "failure notification failed for {}: {err}",
            queue.table_name()
          ));
        }
        failed_this_flush.push(entry);
      }
    }
  }

  for mut entry in failed_this_flush {
    if any_succeeded {
      entry.poison_attempts = entry.poison_attempts.saturating_add(1);
    }
    if entry.poison_attempts < MAX_POISON_NOTIFY_ATTEMPTS
      && entry.enqueued_at.elapsed() < MAX_PENDING_FAILURE_AGE
    {
      tracing::warn!(
        module = "nuq/rabbitmq",
        queue = queue.table_name(),
        poison_attempts = entry.poison_attempts,
        max_poison_attempts = MAX_POISON_NOTIFY_ATTEMPTS,
        "Failed to publish NuQ job failure notification; retaining for retry"
      );
      // Rotate to the back so one poison entry cannot head-of-line block others.
      pending_failures.push_back(entry);
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

  match first_error {
    Some(err) => Err(err),
    None => Ok(()),
  }
}

async fn run_prefetch_cycle<S, P>(
  queue: QueueKind,
  store: &S,
  publisher: &P,
  pending_failures: &mut VecDeque<PendingFailureNotification>,
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
        if !pending_failures.is_empty() {
          let _ =
            flush_pending_failure_notifications(queue, publisher, pending_failures, false).await;
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

    // Always attempt to deliver terminal failure notifications even when a
    // valid-job publish failed earlier in the batch; failures remain queued for
    // retry on subsequent loop iterations.
    let broker_healthy_hint = sent > 0 && publish_error.is_none();
    let notify_error =
      flush_pending_failure_notifications(queue, publisher, pending_failures, broker_healthy_hint)
        .await
        .err();

    if let Some(err) = publish_error {
      return Err(err);
    }
    if let Some(repair_err) = batch.repair_error {
      return Err(format!(
        "decode repair failed for {}: {repair_err}",
        queue.table_name()
      ));
    }
    if let Some(err) = notify_error {
      return Err(err);
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
  let mut pending_failures: VecDeque<PendingFailureNotification> = VecDeque::new();
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
    let _ =
      flush_pending_failure_notifications(queue, publisher.as_ref(), &mut pending_failures, false)
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
