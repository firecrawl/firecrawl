//! Pure-Rust standalone NuQ prefetch worker library.
//!
//! Claims queued jobs from PostgreSQL (`nuq.queue_scrape` and
//! `nuq.queue_crawl_finished`) via PgBouncer-safe simple queries, publishes
//! wire-compatible JSON payloads to RabbitMQ quorum prefetch queues, and
//! exposes `/health` and `/metrics` endpoints.

pub mod amqp;
pub mod config;
pub mod http;
pub mod job;
pub mod pg;
pub mod timestamp;
pub mod worker;

pub use amqp::{
  AMQP_DELIVERY_MODE_PERSISTENT, AmqpPrefetchPublisher, PREFETCH_MESSAGE_EXPIRATION_MS,
  PREFETCH_QUEUE_MAX_LENGTH, PublishError, prefetch_publish_properties, prefetch_queue_args,
};
pub use config::{
  CliCommand, ConfigError, DEFAULT_PORT, RedactedString, WorkerConfig, parse_cli_args,
  redact_amqp_url, redact_http_url,
};
pub use http::{BoundHttpServer, HttpServerError};
pub use job::{
  JobDecodeError, NuqJob, PREFETCH_RETURNING_COLUMNS, QueueKind, stored_zero_data_retention,
};
pub use pg::{
  DEFAULT_POOL_MAX_SIZE, PgConfigError, PgConnectionSettings, PgSslMode, PgStore, PoolMetrics,
  StoreError, format_pool_metrics, parse_pg_connection_settings,
};
pub use timestamp::{
  JS_DATE_MAX_EPOCH_MILLIS, TimestampError, format_epoch_millis_iso_utc,
  parse_pg_timestamp_to_epoch_millis, parse_pg_timestamp_to_iso_utc,
};
pub use worker::{
  BoxFuture, DEFAULT_POLL_INTERVAL, HeartbeatClient, MAX_ERROR_BACKOFF, PrefetchPublisher,
  PrefetchStore, ReqwestHeartbeatClient, next_error_backoff, run_prefetch_loops, run_prefetch_once,
};
