use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use firecrawl_core::telemetry::{ZdrLayer, zdr_span_filter};
use serde_json::json;
use tokio::sync::{Notify, watch};
use tracing::field::{Field, Visit};
use tracing_subscriber::layer::{Context as LayerContext, SubscriberExt};
use tracing_subscriber::{EnvFilter, Layer};

use firecrawl_nuq_prefetch::{
  BoundHttpServer, BoxFuture, FailedJobNotification, HeartbeatClient, NuqJob, PoolMetrics,
  PrefetchBatch, PrefetchPublisher, PrefetchStore, PublishError, QueueKind, StoreError,
  format_pool_metrics, run_prefetch_loops, run_prefetch_once,
};

struct MockStore {
  healthy: AtomicBool,
  health_errors: AtomicBool,
  prefetch_calls: AtomicUsize,
  metrics: Mutex<PoolMetrics>,
  scrape_batches: Mutex<Vec<Result<PrefetchBatch, StoreError>>>,
  crawl_batches: Mutex<Vec<Result<PrefetchBatch, StoreError>>>,
}

impl MockStore {
  fn new() -> Self {
    Self {
      healthy: AtomicBool::new(true),
      health_errors: AtomicBool::new(false),
      prefetch_calls: AtomicUsize::new(0),
      metrics: Mutex::new(PoolMetrics {
        waiting_count: 1,
        idle_count: 4,
        total_count: 5,
      }),
      scrape_batches: Mutex::new(Vec::new()),
      crawl_batches: Mutex::new(Vec::new()),
    }
  }
}

impl PrefetchStore for MockStore {
  fn prefetch_jobs(&self, queue: QueueKind) -> BoxFuture<'_, Result<PrefetchBatch, StoreError>> {
    Box::pin(async move {
      self.prefetch_calls.fetch_add(1, Ordering::AcqRel);
      let target = match queue {
        QueueKind::Scrape => &self.scrape_batches,
        QueueKind::CrawlFinished => &self.crawl_batches,
      };
      let mut batches = target.lock().unwrap_or_else(PoisonError::into_inner);
      if batches.is_empty() {
        Ok(PrefetchBatch::default())
      } else {
        batches.remove(0)
      }
    })
  }

  fn health_check(&self) -> BoxFuture<'_, Result<bool, StoreError>> {
    Box::pin(async move {
      if self.health_errors.load(Ordering::Acquire) {
        return Err(StoreError::Query("simulated outage".to_owned()));
      }
      Ok(self.healthy.load(Ordering::Acquire))
    })
  }

  fn pool_metrics(&self) -> PoolMetrics {
    *self.metrics.lock().unwrap_or_else(PoisonError::into_inner)
  }
}

struct RecordingPublisher {
  configured: bool,
  published: Mutex<Vec<(QueueKind, String)>>,
  failed_notifications: Mutex<Vec<(QueueKind, String, String)>>,
  fail_next_send_job: AtomicUsize,
  fail_next_notify: AtomicUsize,
  always_fail_notify_channel: Option<String>,
  failed_notify_attempts: AtomicUsize,
  publish_delay: Duration,
  gate_job_id: Option<String>,
  gated_publish_started: Notify,
  release_gate: Notify,
}

impl RecordingPublisher {
  fn new(publish_delay: Duration) -> Self {
    Self {
      configured: true,
      published: Mutex::new(Vec::new()),
      failed_notifications: Mutex::new(Vec::new()),
      fail_next_send_job: AtomicUsize::new(0),
      fail_next_notify: AtomicUsize::new(0),
      always_fail_notify_channel: None,
      failed_notify_attempts: AtomicUsize::new(0),
      publish_delay,
      gate_job_id: None,
      gated_publish_started: Notify::new(),
      release_gate: Notify::new(),
    }
  }

  fn gated_on(job_id: &str) -> Self {
    Self {
      configured: true,
      published: Mutex::new(Vec::new()),
      failed_notifications: Mutex::new(Vec::new()),
      fail_next_send_job: AtomicUsize::new(0),
      fail_next_notify: AtomicUsize::new(0),
      always_fail_notify_channel: None,
      failed_notify_attempts: AtomicUsize::new(0),
      publish_delay: Duration::ZERO,
      gate_job_id: Some(job_id.to_owned()),
      gated_publish_started: Notify::new(),
      release_gate: Notify::new(),
    }
  }

  fn unconfigured() -> Self {
    Self {
      configured: false,
      ..Self::new(Duration::ZERO)
    }
  }

  fn failing_notify_channel(channel: &str) -> Self {
    Self {
      always_fail_notify_channel: Some(channel.to_owned()),
      ..Self::new(Duration::ZERO)
    }
  }
}

impl PrefetchPublisher for RecordingPublisher {
  fn is_configured(&self) -> bool {
    self.configured
  }

  fn send_job<'a>(
    &'a self,
    queue: QueueKind,
    job: &'a NuqJob,
  ) -> BoxFuture<'a, Result<(), PublishError>> {
    Box::pin(async move {
      if self
        .fail_next_send_job
        .try_update(Ordering::AcqRel, Ordering::Acquire, |n| n.checked_sub(1))
        .is_ok()
      {
        return Err(PublishError::Amqp("simulated publish error".to_owned()));
      }
      if self.gate_job_id.as_deref() == Some(job.id.as_str()) {
        let release = self.release_gate.notified();
        tokio::pin!(release);
        release.as_mut().enable();
        self.gated_publish_started.notify_waiters();
        release.await;
      }
      if !self.publish_delay.is_zero() {
        tokio::time::sleep(self.publish_delay).await;
      }
      tracing::info!(
        module = "nuq/rabbitmq",
        queue = queue.table_name(),
        job_id = %job.id,
        "NuQ job prefetch sent"
      );
      self
        .published
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .push((queue, job.id.clone()));
      Ok(())
    })
  }

  fn send_job_failed<'a>(
    &'a self,
    queue: QueueKind,
    job_id: &'a str,
    listen_channel_id: &'a str,
  ) -> BoxFuture<'a, Result<(), PublishError>> {
    Box::pin(async move {
      if self.always_fail_notify_channel.as_deref() == Some(listen_channel_id) {
        self.failed_notify_attempts.fetch_add(1, Ordering::AcqRel);
        return Err(PublishError::Amqp("poison notify channel".to_owned()));
      }
      if self
        .fail_next_notify
        .try_update(Ordering::AcqRel, Ordering::Acquire, |n| n.checked_sub(1))
        .is_ok()
      {
        return Err(PublishError::Amqp("simulated notify error".to_owned()));
      }
      self
        .failed_notifications
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .push((queue, job_id.to_owned(), listen_channel_id.to_owned()));
      Ok(())
    })
  }

  fn shutdown(&self) -> BoxFuture<'_, ()> {
    Box::pin(async {})
  }
}

struct CountingHeartbeat {
  pings: AtomicUsize,
  delay: Duration,
}

impl HeartbeatClient for CountingHeartbeat {
  fn ping(&self) -> BoxFuture<'_, ()> {
    Box::pin(async move {
      self.pings.fetch_add(1, Ordering::AcqRel);
      if !self.delay.is_zero() {
        tokio::time::sleep(self.delay).await;
      }
    })
  }
}

fn sample_job(id: &str, zdr: bool) -> NuqJob {
  NuqJob {
    id: id.to_owned(),
    status: "active".to_owned(),
    created_at: "2026-11-26T02:00:00.000Z".to_owned(),
    priority: 0,
    data: json!({
      "url": "https://example.com",
      "ctx": { "zeroDataRetention": zdr }
    }),
    finished_at: None,
    listen_channel_id: None,
    returnvalue: None,
    failed_reason: None,
    lock: Some("lock-1".to_owned()),
    owner_id: None,
    group_id: None,
  }
}

#[tokio::test]
async fn http_server_exposes_health_metrics_and_graceful_shutdown() {
  firecrawl_core::telemetry::ensure_crypto_provider();
  let store = Arc::new(MockStore::new());
  let server =
    BoundHttpServer::bind(SocketAddr::from(([127, 0, 0, 1], 0)), Arc::clone(&store)).await;
  assert!(server.is_ok());
  let Ok(server) = server else { return };
  let addr = server.local_addr();

  let (shutdown_tx, shutdown_rx) = watch::channel(false);
  let handle = tokio::spawn(server.serve(shutdown_rx));

  let client = reqwest::Client::new();
  let base = format!("http://{addr}");

  let health_ok = client.get(format!("{base}/health")).send().await;
  assert!(health_ok.is_ok());
  if let Ok(resp) = health_ok {
    assert_eq!(resp.status(), 200);
    assert_eq!(resp.text().await.ok().as_deref(), Some("OK"));
  }

  let head_ok = client.head(format!("{base}/health")).send().await;
  assert!(head_ok.is_ok());
  if let Ok(resp) = head_ok {
    assert_eq!(resp.status(), 200);
    let cl = resp
      .headers()
      .get("content-length")
      .and_then(|v| v.to_str().ok())
      .map(str::to_owned);
    assert_eq!(cl.as_deref(), Some("2"));
    assert_eq!(resp.text().await.ok().as_deref(), Some(""));
  }

  store.healthy.store(false, Ordering::Release);
  let health_false = client.get(format!("{base}/health")).send().await;
  assert!(health_false.is_ok());
  if let Ok(resp) = health_false {
    assert_eq!(resp.status(), 500);
    assert_eq!(resp.text().await.ok().as_deref(), Some("Not OK"));
  }

  store.health_errors.store(true, Ordering::Release);
  let health_err = client.get(format!("{base}/health")).send().await;
  assert!(health_err.is_ok());
  if let Ok(resp) = health_err {
    assert_eq!(resp.status(), 500);
    assert_eq!(resp.text().await.ok().as_deref(), Some("Not OK"));
  }

  let metrics_resp = client.get(format!("{base}/metrics")).send().await;
  assert!(metrics_resp.is_ok());
  if let Ok(resp) = metrics_resp {
    assert_eq!(resp.status(), 200);
    let ct = resp
      .headers()
      .get("content-type")
      .and_then(|v| v.to_str().ok())
      .map(str::to_owned);
    assert_eq!(ct.as_deref(), Some("text/plain; charset=utf-8"));
    let body = resp.text().await.ok();
    assert_eq!(
      body,
      Some(format_pool_metrics(PoolMetrics {
        waiting_count: 1,
        idle_count: 4,
        total_count: 5,
      }))
    );
  }

  let method_resp = client.post(format!("{base}/health")).send().await;
  assert!(method_resp.is_ok());
  if let Ok(resp) = method_resp {
    assert_eq!(resp.status(), 405);
  }

  let not_found = client.get(format!("{base}/unknown")).send().await;
  assert!(not_found.is_ok());
  if let Ok(resp) = not_found {
    assert_eq!(resp.status(), 404);
  }

  let _ = shutdown_tx.send(true);
  assert!(matches!(
    tokio::time::timeout(Duration::from_secs(3), handle).await,
    Ok(Ok(()))
  ));
}

#[tokio::test]
async fn http_server_and_loops_exit_when_shutdown_sender_is_dropped() {
  let store = Arc::new(MockStore::new());
  let server =
    BoundHttpServer::bind(SocketAddr::from(([127, 0, 0, 1], 0)), Arc::clone(&store)).await;
  assert!(server.is_ok());
  let Ok(server) = server else { return };

  let (shutdown_tx, shutdown_rx) = watch::channel(false);
  let http_handle = tokio::spawn(server.serve(shutdown_rx.clone()));
  let publisher = Arc::new(RecordingPublisher::new(Duration::ZERO));
  let loops_handle = tokio::spawn(run_prefetch_loops(
    Arc::clone(&store),
    publisher,
    Option::<Arc<CountingHeartbeat>>::None,
    Duration::from_secs(10),
    shutdown_rx,
  ));

  // Dropping the sender without sending `true` must terminate cleanly without spinning.
  drop(shutdown_tx);
  assert!(matches!(
    tokio::time::timeout(Duration::from_secs(2), http_handle).await,
    Ok(Ok(()))
  ));
  assert!(matches!(
    tokio::time::timeout(Duration::from_secs(2), loops_handle).await,
    Ok(Ok(()))
  ));
}

#[tokio::test]
async fn unconfigured_publisher_skips_claiming_jobs_from_postgres() {
  let store = MockStore::new();
  {
    let mut scrape = store
      .scrape_batches
      .lock()
      .unwrap_or_else(PoisonError::into_inner);
    scrape.push(Ok(PrefetchBatch::from_jobs(vec![sample_job(
      "should-not-claim",
      false,
    )])));
  }
  let publisher = RecordingPublisher::unconfigured();
  let res = run_prefetch_once(QueueKind::Scrape, &store, &publisher).await;
  assert_eq!(res, Ok(0));
  assert_eq!(store.prefetch_calls.load(Ordering::Acquire), 0);
}

#[tokio::test]
async fn run_prefetch_once_notifies_failed_waiters_and_propagates_repair_errors() {
  let store = MockStore::new();
  {
    let mut scrape = store
      .scrape_batches
      .lock()
      .unwrap_or_else(PoisonError::into_inner);
    scrape.push(Ok(PrefetchBatch {
      jobs: vec![sample_job("valid-1", false)],
      failed_notifications: vec![FailedJobNotification {
        id: "corrupt-1".to_owned(),
        listen_channel_id: Some("chan-7".to_owned()),
      }],
      repair_error: Some(StoreError::Query("repair update failed".to_owned())),
    }));
  }

  let publisher = RecordingPublisher::new(Duration::ZERO);
  let res = run_prefetch_once(QueueKind::Scrape, &store, &publisher).await;
  // Valid job still publishes and repaired waiter still gets notified before propagating repair error.
  assert!(res.is_err());
  assert_eq!(
    publisher
      .published
      .lock()
      .unwrap_or_else(PoisonError::into_inner)
      .as_slice(),
    &[(QueueKind::Scrape, "valid-1".to_owned())]
  );
  assert_eq!(
    publisher
      .failed_notifications
      .lock()
      .unwrap_or_else(PoisonError::into_inner)
      .as_slice(),
    &[(
      QueueKind::Scrape,
      "corrupt-1".to_owned(),
      "chan-7".to_owned()
    )]
  );
}

#[tokio::test]
async fn failed_waiter_notifications_still_send_after_publish_error_and_retry_across_loop_ticks() {
  // Part 1: valid job publish error must not skip failure notification for undecodable rows.
  let store = MockStore::new();
  {
    let mut scrape = store
      .scrape_batches
      .lock()
      .unwrap_or_else(PoisonError::into_inner);
    scrape.push(Ok(PrefetchBatch {
      jobs: vec![sample_job("will-fail-publish", false)],
      failed_notifications: vec![FailedJobNotification {
        id: "corrupt-during-pub-err".to_owned(),
        listen_channel_id: Some("chan-err".to_owned()),
      }],
      repair_error: None,
    }));
  }
  let publisher = RecordingPublisher::new(Duration::ZERO);
  publisher.fail_next_send_job.store(1, Ordering::Release);
  assert!(
    run_prefetch_once(QueueKind::Scrape, &store, &publisher)
      .await
      .is_err()
  );
  assert_eq!(
    publisher
      .failed_notifications
      .lock()
      .unwrap_or_else(PoisonError::into_inner)
      .as_slice(),
    &[(
      QueueKind::Scrape,
      "corrupt-during-pub-err".to_owned(),
      "chan-err".to_owned()
    )]
  );

  // Part 2: transient notify failure is retained and retried on the next loop tick.
  let loop_store = Arc::new(MockStore::new());
  {
    let mut scrape = loop_store
      .scrape_batches
      .lock()
      .unwrap_or_else(PoisonError::into_inner);
    scrape.push(Ok(PrefetchBatch {
      jobs: Vec::new(),
      failed_notifications: vec![FailedJobNotification {
        id: "corrupt-retry".to_owned(),
        listen_channel_id: Some("chan-retry".to_owned()),
      }],
      repair_error: None,
    }));
  }
  let loop_pub = Arc::new(RecordingPublisher::new(Duration::ZERO));
  loop_pub.fail_next_notify.store(1, Ordering::Release);

  let (shutdown_tx, shutdown_rx) = watch::channel(false);
  let handle = tokio::spawn(run_prefetch_loops(
    Arc::clone(&loop_store),
    Arc::clone(&loop_pub),
    Option::<Arc<CountingHeartbeat>>::None,
    Duration::from_millis(10),
    shutdown_rx,
  ));

  let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
  while loop_pub
    .failed_notifications
    .lock()
    .unwrap_or_else(PoisonError::into_inner)
    .is_empty()
    && tokio::time::Instant::now() < deadline
  {
    tokio::time::sleep(Duration::from_millis(10)).await;
  }

  let _ = shutdown_tx.send(true);
  assert!(matches!(
    tokio::time::timeout(Duration::from_secs(2), handle).await,
    Ok(Ok(()))
  ));
  assert_eq!(loop_pub.fail_next_notify.load(Ordering::Acquire), 0);
  assert_eq!(
    loop_pub
      .failed_notifications
      .lock()
      .unwrap_or_else(PoisonError::into_inner)
      .as_slice(),
    &[(
      QueueKind::Scrape,
      "corrupt-retry".to_owned(),
      "chan-retry".to_owned()
    )]
  );
}

#[tokio::test]
async fn stuck_failure_notification_does_not_block_job_claims_or_other_notifications() {
  let store = Arc::new(MockStore::new());
  {
    let mut scrape = store
      .scrape_batches
      .lock()
      .unwrap_or_else(PoisonError::into_inner);
    scrape.push(Ok(PrefetchBatch {
      jobs: Vec::new(),
      failed_notifications: vec![
        FailedJobNotification {
          id: "poison-1".to_owned(),
          listen_channel_id: Some("chan-poison".to_owned()),
        },
        FailedJobNotification {
          id: "good-fail-1".to_owned(),
          listen_channel_id: Some("chan-good".to_owned()),
        },
      ],
      repair_error: None,
    }));
    scrape.push(Ok(PrefetchBatch::from_jobs(vec![sample_job(
      "valid-after-poison",
      false,
    )])));
  }

  let publisher = Arc::new(RecordingPublisher::failing_notify_channel("chan-poison"));
  let heartbeat = Arc::new(CountingHeartbeat {
    pings: AtomicUsize::new(0),
    delay: Duration::ZERO,
  });

  let (shutdown_tx, shutdown_rx) = watch::channel(false);
  let handle = tokio::spawn(run_prefetch_loops(
    Arc::clone(&store),
    Arc::clone(&publisher),
    Some(Arc::clone(&heartbeat)),
    Duration::from_millis(10),
    shutdown_rx,
  ));

  // Wait until the poison notification has been dropped and a clean cycle fires heartbeat.
  let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
  while heartbeat.pings.load(Ordering::Acquire) == 0 && tokio::time::Instant::now() < deadline {
    tokio::time::sleep(Duration::from_millis(10)).await;
  }

  let _ = shutdown_tx.send(true);
  assert!(matches!(
    tokio::time::timeout(Duration::from_secs(2), handle).await,
    Ok(Ok(()))
  ));

  // Valid jobs still claimed and published while the poison notification was pending.
  assert_eq!(
    publisher
      .published
      .lock()
      .unwrap_or_else(PoisonError::into_inner)
      .as_slice(),
    &[(QueueKind::Scrape, "valid-after-poison".to_owned())]
  );
  // Healthy notification behind the poison entry still delivered without head-of-line blocking.
  assert_eq!(
    publisher
      .failed_notifications
      .lock()
      .unwrap_or_else(PoisonError::into_inner)
      .as_slice(),
    &[(
      QueueKind::Scrape,
      "good-fail-1".to_owned(),
      "chan-good".to_owned()
    )]
  );
  // Poison notification was retried a bounded number of times (5) and then evicted.
  assert_eq!(publisher.failed_notify_attempts.load(Ordering::Acquire), 5);
  assert!(heartbeat.pings.load(Ordering::Acquire) >= 1);
}

#[tokio::test]
async fn prefetch_loops_run_both_queues_with_nonblocking_heartbeat_and_finish_inflight_batch() {
  let store = Arc::new(MockStore::new());
  {
    let mut scrape = store
      .scrape_batches
      .lock()
      .unwrap_or_else(PoisonError::into_inner);
    scrape.push(Err(StoreError::Query("transient blip".to_owned())));
    scrape.push(Ok(PrefetchBatch::from_jobs(vec![
      sample_job("scrape-1", false),
      sample_job("scrape-2", true),
    ])));
  }
  {
    let mut crawl = store
      .crawl_batches
      .lock()
      .unwrap_or_else(PoisonError::into_inner);
    crawl.push(Ok(PrefetchBatch::from_jobs(vec![sample_job(
      "crawl-1", false,
    )])));
  }

  let publisher = Arc::new(RecordingPublisher::gated_on("scrape-1"));
  // Heartbeat deliberately sleeps longer than poll_interval to verify it never stalls prefetching.
  let heartbeat = Arc::new(CountingHeartbeat {
    pings: AtomicUsize::new(0),
    delay: Duration::from_secs(2),
  });

  let (shutdown_tx, shutdown_rx) = watch::channel(false);
  let gated_started = publisher.gated_publish_started.notified();
  tokio::pin!(gated_started);
  gated_started.as_mut().enable();

  let loops = tokio::spawn(run_prefetch_loops(
    Arc::clone(&store),
    Arc::clone(&publisher),
    Some(Arc::clone(&heartbeat)),
    Duration::from_millis(15),
    shutdown_rx,
  ));

  // Wait deterministically until the 2-job scrape batch is blocked mid-publish.
  assert!(
    tokio::time::timeout(Duration::from_secs(3), gated_started)
      .await
      .is_ok(),
    "scrape-1 publish never started"
  );
  // First scrape attempt errored, so heartbeat must not have fired before the first success.
  assert_eq!(heartbeat.pings.load(Ordering::Acquire), 0);

  // Ensure the independent crawl-finished loop has also processed its batch while scrape is paused.
  let crawl_deadline = tokio::time::Instant::now() + Duration::from_secs(2);
  while !publisher
    .published
    .lock()
    .unwrap_or_else(PoisonError::into_inner)
    .contains(&(QueueKind::CrawlFinished, "crawl-1".to_owned()))
    && tokio::time::Instant::now() < crawl_deadline
  {
    tokio::time::sleep(Duration::from_millis(5)).await;
  }

  // Trigger shutdown WHILE the 2-job scrape batch is in-flight, then release it.
  let _ = shutdown_tx.send(true);
  publisher.release_gate.notify_waiters();

  assert!(matches!(
    tokio::time::timeout(Duration::from_secs(3), loops).await,
    Ok(Ok(()))
  ));

  let published = publisher
    .published
    .lock()
    .unwrap_or_else(PoisonError::into_inner)
    .clone();
  assert!(published.contains(&(QueueKind::CrawlFinished, "crawl-1".to_owned())));
  assert!(published.contains(&(QueueKind::Scrape, "scrape-1".to_owned())));
  assert!(published.contains(&(QueueKind::Scrape, "scrape-2".to_owned())));
  // Heartbeat fired once after the successful scrape batch and stayed bounded to 1 in-flight call.
  let hb_deadline = tokio::time::Instant::now() + Duration::from_secs(1);
  while heartbeat.pings.load(Ordering::Acquire) == 0 && tokio::time::Instant::now() < hb_deadline {
    tokio::time::sleep(Duration::from_millis(5)).await;
  }
  assert_eq!(heartbeat.pings.load(Ordering::Acquire), 1);
}

struct MessageVisitor {
  job_id: Option<String>,
  message: Option<String>,
}

impl Visit for MessageVisitor {
  fn record_str(&mut self, field: &Field, value: &str) {
    if field.name() == "job_id" {
      self.job_id = Some(value.to_owned());
    } else if field.name() == "message" {
      self.message = Some(value.to_owned());
    }
  }

  fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
    if field.name() == "job_id" {
      self.job_id = Some(format!("{value:?}"));
    } else if field.name() == "message" {
      self.message = Some(format!("{value:?}"));
    }
  }
}

type CapturedEvents = Arc<Mutex<Vec<(Option<String>, Option<String>)>>>;

struct EventCaptureLayer {
  events: CapturedEvents,
}

impl<S> Layer<S> for EventCaptureLayer
where
  S: tracing::Subscriber + for<'a> tracing_subscriber::registry::LookupSpan<'a>,
{
  fn on_event(&self, event: &tracing::Event<'_>, _ctx: LayerContext<'_, S>) {
    let mut visitor = MessageVisitor {
      job_id: None,
      message: None,
    };
    event.record(&mut visitor);
    self
      .events
      .lock()
      .unwrap_or_else(PoisonError::into_inner)
      .push((visitor.job_id, visitor.message));
  }
}

#[tokio::test]
async fn zdr_layer_suppresses_logs_for_zdr_jobs_and_emits_for_normal_jobs() {
  use tracing::instrument::WithSubscriber;

  let store = MockStore::new();
  {
    let mut scrape = store
      .scrape_batches
      .lock()
      .unwrap_or_else(PoisonError::into_inner);
    scrape.push(Ok(PrefetchBatch::from_jobs(vec![
      sample_job("normal-job-id", false),
      sample_job("zdr-job-id", true),
    ])));
  }
  let publisher = RecordingPublisher::new(Duration::ZERO);
  let captured: CapturedEvents = Arc::new(Mutex::new(Vec::new()));

  let subscriber = tracing_subscriber::registry()
    .with(ZdrLayer.with_filter(zdr_span_filter(EnvFilter::new("info"))))
    .with(EventCaptureLayer {
      events: Arc::clone(&captured),
    });

  let res = run_prefetch_once(QueueKind::Scrape, &store, &publisher)
    .with_subscriber(subscriber)
    .await;
  assert_eq!(res, Ok(2));

  let events = captured.lock().unwrap_or_else(PoisonError::into_inner);
  let logged_job_ids: Vec<&str> = events
    .iter()
    .filter_map(|(job_id, _)| job_id.as_deref())
    .collect();
  assert!(logged_job_ids.contains(&"normal-job-id"));
  assert!(!logged_job_ids.contains(&"zdr-job-id"));
}
