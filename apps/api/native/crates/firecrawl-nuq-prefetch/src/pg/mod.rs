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
  pub async fn prefetch_jobs(&self, queue: QueueKind) -> Result<Vec<NuqJob>, StoreError> {
    let client = self
      .pool
      .get()
      .await
      .map_err(|err| StoreError::PoolAcquire(err.to_string()))?;

    let messages =
      run_simple_query_with_timeout(client, queue.prefetch_sql(), PREFETCH_QUERY_TIMEOUT).await?;

    let mut jobs = Vec::new();
    for msg in messages {
      if let SimpleQueryMessage::Row(row) = msg {
        jobs.push(NuqJob::from_pg_row(&row)?);
      }
    }
    Ok(jobs)
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
}
