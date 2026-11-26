//! Prefetch worker loop orchestration, service traits, bounded fire-and-forget
//! heartbeat client, and ZDR-protected per-job publish spans.

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
use crate::pg::{PgStore, PoolMetrics, PrefetchBatch, StoreError};

/// Default polling interval matching `setTimeout(resolve, 250)` in `nuq-prefetch-worker.ts`.
pub const DEFAULT_POLL_INTERVAL: Duration = Duration::from_millis(250);

/// Maximum backoff applied after consecutive transient store errors.
pub const MAX_ERROR_BACKOFF: Duration = Duration::from_secs(5);

const HEARTBEAT_REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const HEARTBEAT_CONNECT_TIMEOUT: Duration = Duration::from_secs(3);

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

    let batch = store
      .prefetch_jobs(queue)
      .await
      .map_err(|err| format!("prefetch query failed for {}: {err}", queue.table_name()))?;

    let mut sent = 0_usize;
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
        return Err(format!(
          "publish failed for {} after {sent}/{} jobs: {err}",
          queue.table_name(),
          batch.jobs.len()
        ));
      }
      sent = sent.saturating_add(1);
    }

    let mut notify_error: Option<String> = None;
    for failed in &batch.failed_notifications {
      if let Some(listen_channel_id) = failed.listen_channel_id.as_deref()
        && let Err(err) = publisher
          .send_job_failed(queue, &failed.id, listen_channel_id)
          .await
      {
        tracing::warn!(
          module = "nuq/rabbitmq",
          queue = queue.table_name(),
          error = %err,
          "Failed to publish NuQ job failure notification"
        );
        if notify_error.is_none() {
          notify_error = Some(format!(
            "failure notification failed for {}: {err}",
            queue.table_name()
          ));
        }
      }
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
  let mut backoff = poll_interval;

  while !*shutdown.borrow() {
    let sleep_duration = match run_prefetch_once(queue, store.as_ref(), publisher.as_ref()).await {
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
