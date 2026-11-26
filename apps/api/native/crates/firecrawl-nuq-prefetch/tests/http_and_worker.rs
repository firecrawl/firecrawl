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
  BoundHttpServer, BoxFuture, HeartbeatClient, NuqJob, PoolMetrics, PrefetchPublisher,
  PrefetchStore, PublishError, QueueKind, StoreError, format_pool_metrics, run_prefetch_loops,
  run_prefetch_once,
};

struct MockStore {
  healthy: AtomicBool,
  health_errors: AtomicBool,
  metrics: Mutex<PoolMetrics>,
  scrape_batches: Mutex<Vec<Result<Vec<NuqJob>, StoreError>>>,
  crawl_batches: Mutex<Vec<Result<Vec<NuqJob>, StoreError>>>,
}

impl MockStore {
  fn new() -> Self {
    Self {
      healthy: AtomicBool::new(true),
      health_errors: AtomicBool::new(false),
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
  fn prefetch_jobs(&self, queue: QueueKind) -> BoxFuture<'_, Result<Vec<NuqJob>, StoreError>> {
    Box::pin(async move {
      let target = match queue {
        QueueKind::Scrape => &self.scrape_batches,
        QueueKind::CrawlFinished => &self.crawl_batches,
      };
      let mut batches = target.lock().unwrap_or_else(PoisonError::into_inner);
      if batches.is_empty() {
        Ok(Vec::new())
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
  published: Mutex<Vec<(QueueKind, String)>>,
  publish_delay: Duration,
  first_publish_started: Notify,
}

impl RecordingPublisher {
  fn new(publish_delay: Duration) -> Self {
    Self {
      published: Mutex::new(Vec::new()),
      publish_delay,
      first_publish_started: Notify::new(),
    }
  }
}

impl PrefetchPublisher for RecordingPublisher {
  fn send_job<'a>(
    &'a self,
    queue: QueueKind,
    job: &'a NuqJob,
  ) -> BoxFuture<'a, Result<(), PublishError>> {
    Box::pin(async move {
      self.first_publish_started.notify_one();
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
  assert!(
    tokio::time::timeout(Duration::from_secs(3), handle)
      .await
      .is_ok()
  );
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
    scrape.push(Ok(vec![
      sample_job("scrape-1", false),
      sample_job("scrape-2", true),
    ]));
  }
  {
    let mut crawl = store
      .crawl_batches
      .lock()
      .unwrap_or_else(PoisonError::into_inner);
    crawl.push(Ok(vec![sample_job("crawl-1", false)]));
  }

  let publisher = Arc::new(RecordingPublisher::new(Duration::from_millis(25)));
  // Heartbeat deliberately sleeps longer than poll_interval to verify it never stalls prefetching.
  let heartbeat = Arc::new(CountingHeartbeat {
    pings: AtomicUsize::new(0),
    delay: Duration::from_secs(2),
  });

  let (shutdown_tx, shutdown_rx) = watch::channel(false);
  let loops = tokio::spawn(run_prefetch_loops(
    Arc::clone(&store),
    Arc::clone(&publisher),
    Some(Arc::clone(&heartbeat)),
    Duration::from_millis(15),
    shutdown_rx,
  ));

  // Wait until both queues have processed their batches (scrape recovers after error).
  let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
  loop {
    let count = publisher
      .published
      .lock()
      .unwrap_or_else(PoisonError::into_inner)
      .len();
    if count >= 3 || tokio::time::Instant::now() >= deadline {
      break;
    }
    tokio::time::sleep(Duration::from_millis(10)).await;
  }

  let _ = shutdown_tx.send(true);
  assert!(
    tokio::time::timeout(Duration::from_secs(3), loops)
      .await
      .is_ok()
  );

  let published = publisher
    .published
    .lock()
    .unwrap_or_else(PoisonError::into_inner)
    .clone();
  assert!(published.contains(&(QueueKind::CrawlFinished, "crawl-1".to_owned())));
  assert!(published.contains(&(QueueKind::Scrape, "scrape-1".to_owned())));
  assert!(published.contains(&(QueueKind::Scrape, "scrape-2".to_owned())));
  // Semaphore gate keeps slow heartbeat to 1 in-flight call.
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
    scrape.push(Ok(vec![
      sample_job("normal-job-id", false),
      sample_job("zdr-job-id", true),
    ]));
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
