//! PgBouncer transaction-mode-safe PostgreSQL connection pool and query store.
//!
//! All SQL executes through PostgreSQL's Simple Query Protocol (`simple_query`)
//! with `RecyclingMethod::Fast` so zero session-scoped named prepared statements
//! or `DISCARD ALL` statements are ever issued.

pub mod config;
pub mod tls;

use std::fmt;
use std::time::{Duration, Instant};

use deadpool_postgres::{Manager, ManagerConfig, Object, Pool, RecyclingMethod, Runtime, Timeouts};
use thiserror::Error;
use tokio_postgres::{NoTls, SimpleQueryMessage};

use crate::job::{JobDecodeError, NuqJob, QueueKind};
use crate::pg::tls::{PgTlsError, build_rustls_connector};

pub use config::{PgConfigError, PgConnectionSettings, PgSslMode, parse_pg_connection_settings};

/// Default maximum connections per pool, matching `node-postgres` `Pool` default.
pub const DEFAULT_POOL_MAX_SIZE: usize = 10;
const POOL_WAIT_TIMEOUT: Duration = Duration::from_secs(10);
const POOL_CREATE_TIMEOUT: Duration = Duration::from_secs(10);
const POOL_RECYCLE_TIMEOUT: Duration = Duration::from_secs(5);
const PREFETCH_QUERY_TIMEOUT: Duration = Duration::from_secs(30);
const HEALTH_QUERY_TIMEOUT: Duration = Duration::from_secs(5);

/// A claimed row that could not be decoded and was transitioned to `failed`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FailedJobNotification {
  pub id: String,
  pub listen_channel_id: Option<String>,
}

/// Result of a single PostgreSQL prefetch query, separating valid claimed jobs
/// from undecodable rows that were marked `failed` and any repair error.
#[derive(Debug, Default)]
pub struct PrefetchBatch {
  pub jobs: Vec<NuqJob>,
  pub failed_notifications: Vec<FailedJobNotification>,
  pub repair_error: Option<StoreError>,
}

impl PrefetchBatch {
  /// Wraps a plain vector of decoded jobs with no decode failures.
  #[must_use]
  pub fn from_jobs(jobs: Vec<NuqJob>) -> Self {
    Self {
      jobs,
      failed_notifications: Vec::new(),
      repair_error: None,
    }
  }
}

/// Pool occupancy snapshot matching `nuqGetLocalMetrics()` in `nuq.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PoolMetrics {
  pub waiting_count: usize,
  pub idle_count: usize,
  pub total_count: usize,
}

/// Formats pool gauges in exact byte-for-byte parity with `nuqGetLocalMetrics()`.
#[must_use]
pub fn format_pool_metrics(metrics: PoolMetrics) -> String {
  format!(
    "# HELP nuq_pool_waiting_count Number of requests waiting in the pool\n\
     # TYPE nuq_pool_waiting_count gauge\n\
     nuq_pool_waiting_count {}\n\
     \n\
     # HELP nuq_pool_idle_count Number of connections idle in the pool\n\
     # TYPE nuq_pool_idle_count gauge\n\
     nuq_pool_idle_count {}\n\
     \n\
     # HELP nuq_pool_total_count Number of connections in the pool\n\
     # TYPE nuq_pool_total_count gauge\n\
     nuq_pool_total_count {}\n",
    metrics.waiting_count, metrics.idle_count, metrics.total_count
  )
}

/// Errors returned by PostgreSQL pool initialization and queries.
#[derive(Debug, Error)]
pub enum StoreError {
  #[error("TLS setup failed: {0}")]
  Tls(#[from] PgTlsError),
  #[error("failed to build PostgreSQL connection pool: {0}")]
  PoolBuild(String),
  #[error("failed to acquire PostgreSQL connection from pool: {0}")]
  PoolAcquire(String),
  #[error("PostgreSQL query timed out after {0}ms")]
  QueryTimeout(u64),
  #[error("PostgreSQL query failed: {0}")]
  Query(String),
  #[error("failed to decode prefetched job row: {0}")]
  Decode(#[from] JobDecodeError),
}

/// Asynchronous PostgreSQL store backed by a PgBouncer-safe `deadpool-postgres` pool.
pub struct PgStore {
  pool: Pool,
  redacted_endpoint: String,
  ssl_mode: PgSslMode,
}

impl fmt::Debug for PgStore {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.debug_struct("PgStore")
      .field("endpoint", &self.redacted_endpoint)
      .field("ssl_mode", &self.ssl_mode)
      .field("metrics", &self.pool_metrics())
      .finish()
  }
}

impl PgStore {
  /// Builds a PostgreSQL connection pool from parsed settings.
  pub fn new(settings: &PgConnectionSettings) -> Result<Self, StoreError> {
    Self::with_max_size(settings, DEFAULT_POOL_MAX_SIZE)
  }

  /// Builds a PostgreSQL connection pool with an explicit max connection count.
  pub fn with_max_size(
    settings: &PgConnectionSettings,
    max_size: usize,
  ) -> Result<Self, StoreError> {
    let mgr_cfg = ManagerConfig {
      recycling_method: RecyclingMethod::Fast,
    };

    let manager = match settings.ssl_mode() {
      PgSslMode::Disable => Manager::from_config(settings.pg_config().clone(), NoTls, mgr_cfg),
      mode => {
        let tls = build_rustls_connector(mode, settings.ssl_root_cert())?;
        Manager::from_config(settings.pg_config().clone(), tls, mgr_cfg)
      }
    };

    let pool = Pool::builder(manager)
      .max_size(max_size)
      .timeouts(Timeouts {
        wait: Some(POOL_WAIT_TIMEOUT),
        create: Some(POOL_CREATE_TIMEOUT),
        recycle: Some(POOL_RECYCLE_TIMEOUT),
      })
      .runtime(Runtime::Tokio1)
      .build()
      .map_err(|err| StoreError::PoolBuild(err.to_string()))?;

    Ok(Self {
      pool,
      redacted_endpoint: settings.redacted_endpoint().to_owned(),
      ssl_mode: settings.ssl_mode(),
    })
  }

  /// Claims up to 500 queued jobs from `queue` using the Simple Query Protocol.
  pub async fn prefetch_jobs(&self, queue: QueueKind) -> Result<PrefetchBatch, StoreError> {
    let client = self
      .pool
      .get()
      .await
      .map_err(|err| StoreError::PoolAcquire(err.to_string()))?;

    let messages =
      run_simple_query_with_timeout(client, queue.prefetch_sql(), PREFETCH_QUERY_TIMEOUT).await?;

    let mut batch = PrefetchBatch::default();
    let mut decode_failures: Vec<(String, String)> = Vec::new();
    for msg in messages {
      if let SimpleQueryMessage::Row(row) = msg {
        match NuqJob::from_pg_row(&row) {
          Ok(job) => batch.jobs.push(job),
          Err(err) => {
            tracing::error!(
              module = "nuq",
              queue = queue.table_name(),
              error = %err,
              "Failed to decode prefetched NuQ job row; failing row"
            );
            if let (Ok(Some(id)), Ok(Some(lock))) = (row.try_get("id"), row.try_get("lock"))
              && is_canonical_uuid(id)
              && is_canonical_uuid(lock)
            {
              decode_failures.push((id.to_owned(), lock.to_owned()));
            } else {
              batch.repair_error.get_or_insert_with(|| {
                StoreError::Query(
                  "undecodable prefetched row missing valid canonical UUID id/lock".to_owned(),
                )
              });
            }
          }
        }
      }
    }

    for (id, lock) in decode_failures {
      match self.mark_decode_failed(queue, &id, &lock).await {
        Ok(Some(notification)) => batch.failed_notifications.push(notification),
        Ok(None) => {}
        Err(err) => {
          tracing::warn!(
            module = "nuq",
            queue = queue.table_name(),
            error = %err,
            "Failed to mark undecodable NuQ job row failed after retry"
          );
          batch.repair_error.get_or_insert(err);
        }
      }
    }

    Ok(batch)
  }

  /// Transitions an undecodable claimed row straight to `failed` and emits a
  /// PostgreSQL `pg_notify` failure signal atomically, retrying once on
  /// transient failure and recovering `(id, listen_channel_id)` from the
  /// already-failed row if the first response was lost after commit.
  async fn mark_decode_failed(
    &self,
    queue: QueueKind,
    id: &str,
    lock: &str,
  ) -> Result<Option<FailedJobNotification>, StoreError> {
    let table = queue.table_name();
    let sql = format!(
      "WITH updated AS (\
         UPDATE {table} \
         SET status = 'failed'::nuq.job_status, lock = null, locked_at = null, finished_at = now(), failedreason = 'Failed to decode prefetched NuQ job row' \
         WHERE id = '{id}'::uuid AND lock = '{lock}'::uuid \
         RETURNING id, listen_channel_id\
       ), target AS (\
         SELECT id, listen_channel_id FROM updated \
         UNION ALL \
         SELECT id, listen_channel_id FROM {table} \
         WHERE NOT EXISTS (SELECT 1 FROM updated) \
           AND id = '{id}'::uuid \
           AND status = 'failed'::nuq.job_status \
           AND failedreason = 'Failed to decode prefetched NuQ job row'\
       ) \
       SELECT t.id, t.listen_channel_id, pg_notify('{table}', t.id::text || '|failed') FROM target t;"
    );

    let mut last_err = None;
    for attempt in 0..2_u8 {
      let client = match self.pool.get().await {
        Ok(client) => client,
        Err(err) => {
          last_err = Some(StoreError::PoolAcquire(err.to_string()));
          if attempt == 0 {
            continue;
          }
          break;
        }
      };

      match run_simple_query_with_timeout(client, &sql, HEALTH_QUERY_TIMEOUT).await {
        Ok(messages) => {
          for msg in messages {
            if let SimpleQueryMessage::Row(row) = msg {
              let failed_id = row.try_get("id").ok().flatten().unwrap_or(id).to_owned();
              let listen_channel_id = row
                .try_get("listen_channel_id")
                .ok()
                .flatten()
                .filter(|v| !v.is_empty())
                .map(str::to_owned);
              return Ok(Some(FailedJobNotification {
                id: failed_id,
                listen_channel_id,
              }));
            }
          }
          return Ok(None);
        }
        Err(err) => {
          last_err = Some(err);
          if attempt == 0 {
            continue;
          }
        }
      }
    }

    Err(last_err.unwrap_or_else(|| StoreError::Query("decode repair failed".to_owned())))
  }

  /// Executes `SELECT 1;` via the Simple Query Protocol, matching `nuqHealthCheck()`.
  pub async fn health_check(&self) -> Result<bool, StoreError> {
    let start = Instant::now();
    let result = async {
      let client = self
        .pool
        .get()
        .await
        .map_err(|err| StoreError::PoolAcquire(err.to_string()))?;

      let messages =
        run_simple_query_with_timeout(client, "SELECT 1;", HEALTH_QUERY_TIMEOUT).await?;
      let row_count = messages
        .iter()
        .filter(|msg| matches!(msg, SimpleQueryMessage::Row(_)))
        .count();
      Ok(row_count == 1)
    }
    .await;

    let duration_ms = u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX);
    tracing::info!(
      module = "nuq/metrics",
      method = "nuqHealthCheck",
      duration_ms,
      "nuqHealthCheck metrics"
    );

    result
  }

  /// Returns current waiting, idle, and total connection counts for `/metrics`.
  #[must_use]
  pub fn pool_metrics(&self) -> PoolMetrics {
    let status = self.pool.status();
    PoolMetrics {
      waiting_count: status.waiting,
      idle_count: status.available,
      total_count: status.size,
    }
  }

  /// Closes the pool and prevents new connections from being checked out.
  pub fn close(&self) {
    self.pool.close();
  }
}

/// Strict canonical 8-4-4-4-12 UUID check so simple-query literals carry no
/// untrusted characters.
fn is_canonical_uuid(raw: &str) -> bool {
  let bytes = raw.as_bytes();
  if bytes.len() != 36 {
    return false;
  }
  bytes.iter().enumerate().all(|(idx, &b)| match idx {
    8 | 13 | 18 | 23 => b == b'-',
    _ => b.is_ascii_hexdigit(),
  })
}

async fn run_simple_query_with_timeout(
  client: Object,
  sql: &str,
  timeout: Duration,
) -> Result<Vec<SimpleQueryMessage>, StoreError> {
  match tokio::time::timeout(timeout, client.simple_query(sql)).await {
    Ok(Ok(messages)) => Ok(messages),
    Ok(Err(err)) => {
      // Discard the connection so a broken or desynchronized socket is not recycled.
      let _ = Object::take(client);
      Err(StoreError::Query(err.to_string()))
    }
    Err(_) => {
      let _ = Object::take(client);
      let timeout_ms = u64::try_from(timeout.as_millis()).unwrap_or(u64::MAX);
      Err(StoreError::QueryTimeout(timeout_ms))
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn formats_pool_metrics_matching_nuq_ts_exactly() {
    let text = format_pool_metrics(PoolMetrics {
      waiting_count: 2,
      idle_count: 7,
      total_count: 9,
    });
    let expected = "# HELP nuq_pool_waiting_count Number of requests waiting in the pool\n\
# TYPE nuq_pool_waiting_count gauge\n\
nuq_pool_waiting_count 2\n\n\
# HELP nuq_pool_idle_count Number of connections idle in the pool\n\
# TYPE nuq_pool_idle_count gauge\n\
nuq_pool_idle_count 7\n\n\
# HELP nuq_pool_total_count Number of connections in the pool\n\
# TYPE nuq_pool_total_count gauge\n\
nuq_pool_total_count 9\n";
    assert_eq!(text, expected);
  }

  #[test]
  fn validates_canonical_uuids_strictly() {
    assert!(is_canonical_uuid("00000000-0000-0000-0000-000000000000"));
    assert!(is_canonical_uuid("550E8400-e29b-41d4-A716-446655440000"));
    assert!(!is_canonical_uuid("550e8400-e29b-41d4-a716-44665544000"));
    assert!(!is_canonical_uuid("550e8400-e29b-41d4-a716-446655440000'"));
    assert!(!is_canonical_uuid("550e8400e29b41d4a716446655440000"));
    assert!(!is_canonical_uuid("gggggggg-gggg-gggg-gggg-gggggggggggg"));
  }
}
