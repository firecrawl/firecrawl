//! RabbitMQ prefetch publisher matching `NuQ::startSender` and `NuQ::sendJobPrefetch`
//! in `apps/api/src/services/worker/nuq.ts`.

use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use lapin::options::{BasicPublishOptions, ConfirmSelectOptions, QueueDeclareOptions};
use lapin::types::{AMQPValue, FieldTable};
use lapin::{BasicProperties, Channel, Confirmation, Connection, ConnectionProperties};
use thiserror::Error;
use tokio::sync::Mutex;

use crate::nuq_prefetch::config::{RedactedString, redact_amqp_url};
use crate::nuq_prefetch::job::{NuqJob, QueueKind};

/// RabbitMQ quorum queue `x-max-length` matching `nuq.ts`.
pub const PREFETCH_QUEUE_MAX_LENGTH: i32 = 20_000;

/// Per-message expiration in milliseconds (50s, under the 60s lock reaper).
pub const PREFETCH_MESSAGE_EXPIRATION_MS: &str = "50000";

/// AMQP persistent delivery mode matching `persistent: true` in `amqplib`.
pub const AMQP_DELIVERY_MODE_PERSISTENT: u8 = 2;

const AMQP_OP_TIMEOUT: Duration = Duration::from_secs(15);
const AMQP_CLOSE_TIMEOUT: Duration = Duration::from_secs(5);
const CONNECTION_NAME: &str = "nuq-prefetch";

/// Builds the exact `queue.declare` arguments for `<queueName>.prefetch`.
#[must_use]
pub fn prefetch_queue_args() -> FieldTable {
  let mut args = FieldTable::default();
  args.insert(
    "x-queue-type".into(),
    AMQPValue::LongString("quorum".into()),
  );
  args.insert(
    "x-max-length".into(),
    AMQPValue::LongInt(PREFETCH_QUEUE_MAX_LENGTH),
  );
  args
}

/// Builds the exact AMQP publish properties for a prefetched job.
#[must_use]
pub fn prefetch_publish_properties(job_id: &str) -> BasicProperties {
  BasicProperties::default()
    .with_correlation_id(job_id.into())
    .with_delivery_mode(AMQP_DELIVERY_MODE_PERSISTENT)
    .with_expiration(PREFETCH_MESSAGE_EXPIRATION_MS.into())
}

/// Errors returned when publishing prefetched jobs to RabbitMQ.
#[derive(Debug, Error)]
pub enum PublishError {
  #[error("NUQ_RABBITMQ_URL is not configured")]
  NotConfigured,
  #[error("publisher is shutting down")]
  ShuttingDown,
  #[error("failed to serialize job payload: {0}")]
  Serialize(String),
  #[error("AMQP operation timed out: {0}")]
  Timeout(&'static str),
  #[error("AMQP publish confirmation timed out; delivery outcome is ambiguous")]
  ConfirmTimeout,
  #[error("AMQP transport failed while awaiting publish confirmation: {0}")]
  ConfirmTransport(String),
  #[error("broker negatively acknowledged prefetch publish")]
  Nacked,
  #[error("AMQP operation failed: {0}")]
  Amqp(String),
}

impl PublishError {
  /// Returns `true` when frames may already have been written to the broker,
  /// so retrying on a fresh connection could enqueue a duplicate message.
  #[must_use]
  pub fn is_ambiguous_outcome(&self) -> bool {
    matches!(
      self,
      Self::ConfirmTimeout | Self::ConfirmTransport(_) | Self::Timeout("basic_publish")
    )
  }
}

struct AmqpSession {
  connection: Connection,
  channel: Channel,
}

impl AmqpSession {
  fn is_connected(&self) -> bool {
    self.connection.status().connected() && self.channel.status().connected()
  }

  async fn close_gracefully(self, reason: &str) {
    let _ = tokio::time::timeout(AMQP_CLOSE_TIMEOUT, async {
      if let Err(err) = self.channel.close(200, reason.into()).await {
        tracing::debug!(
          module = "nuq/rabbitmq",
          error = %err,
          "NuQ sender channel already closed"
        );
      }
      if let Err(err) = self.connection.close(200, reason.into()).await {
        tracing::debug!(
          module = "nuq/rabbitmq",
          error = %err,
          "NuQ sender connection already closed"
        );
      }
    })
    .await;
  }
}

/// Per-queue RabbitMQ sender with lazy connection, topology declaration, and
/// automatic reconnect after channel or connection drops.
pub struct AmqpPrefetchPublisher {
  rabbitmq_url: Option<RedactedString>,
  op_timeout: Duration,
  scrape_session: Mutex<Option<AmqpSession>>,
  crawl_finished_session: Mutex<Option<AmqpSession>>,
  shutting_down: AtomicBool,
}

impl fmt::Debug for AmqpPrefetchPublisher {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.debug_struct("AmqpPrefetchPublisher")
      .field(
        "rabbitmq_url",
        &self
          .rabbitmq_url
          .as_ref()
          .map(|u| redact_amqp_url(u.expose())),
      )
      .field("shutting_down", &self.shutting_down.load(Ordering::Relaxed))
      .finish()
  }
}

impl AmqpPrefetchPublisher {
  /// Creates a publisher for an optional `NUQ_RABBITMQ_URL` with the default operation timeout.
  #[must_use]
  pub fn new(rabbitmq_url: Option<RedactedString>) -> Self {
    Self::with_op_timeout(rabbitmq_url, AMQP_OP_TIMEOUT)
  }

  /// Creates a publisher with an explicit per-operation AMQP timeout.
  #[must_use]
  pub fn with_op_timeout(rabbitmq_url: Option<RedactedString>, op_timeout: Duration) -> Self {
    firecrawl_core::telemetry::ensure_crypto_provider();
    Self {
      rabbitmq_url,
      op_timeout,
      scrape_session: Mutex::new(None),
      crawl_finished_session: Mutex::new(None),
      shutting_down: AtomicBool::new(false),
    }
  }

  /// Returns whether `NUQ_RABBITMQ_URL` is configured on this publisher.
  #[must_use]
  pub const fn is_configured(&self) -> bool {
    self.rabbitmq_url.is_some()
  }

  fn session_slot(&self, queue: QueueKind) -> &Mutex<Option<AmqpSession>> {
    match queue {
      QueueKind::Scrape => &self.scrape_session,
      QueueKind::CrawlFinished => &self.crawl_finished_session,
    }
  }

  /// Publishes a single prefetched job to `<queueName>.prefetch` with broker
  /// publisher confirms enabled so failed deliveries remain retryable.
  pub async fn send_job(&self, queue: QueueKind, job: &NuqJob) -> Result<(), PublishError> {
    let payload =
      serde_json::to_vec(job).map_err(|err| PublishError::Serialize(err.to_string()))?;
    let routing_key = queue.prefetch_queue_name();
    let properties = prefetch_publish_properties(&job.id);

    self
      .publish_frame(queue, routing_key, &payload, properties)
      .await?;

    if !job.is_zero_data_retention() {
      tracing::info!(
        module = "nuq/rabbitmq",
        queue = queue.table_name(),
        job_id = %job.id,
        "NuQ job prefetch sent"
      );
    }
    Ok(())
  }

  /// Publishes a terminal `"failed"` notification to `<queueName>.listen.<listen_channel_id>`,
  /// matching `NuQ::sendJobEnd(id, "failed", listenChannelId)` in `nuq.ts`.
  pub async fn send_job_failed(
    &self,
    queue: QueueKind,
    job_id: &str,
    listen_channel_id: &str,
  ) -> Result<(), PublishError> {
    let routing_key = format!("{}.listen.{listen_channel_id}", queue.table_name());
    let properties = BasicProperties::default().with_correlation_id(job_id.into());
    self
      .publish_frame(queue, &routing_key, b"failed", properties)
      .await
  }

  async fn publish_frame(
    &self,
    queue: QueueKind,
    routing_key: &str,
    payload: &[u8],
    properties: BasicProperties,
  ) -> Result<(), PublishError> {
    let Some(url) = self.rabbitmq_url.as_ref() else {
      tracing::warn!(
        module = "nuq/rabbitmq",
        queue = queue.table_name(),
        "NuQ sender not started"
      );
      return Err(PublishError::NotConfigured);
    };

    if self.shutting_down.load(Ordering::Acquire) {
      return Err(PublishError::ShuttingDown);
    }

    let prefetch_queue = queue.prefetch_queue_name();
    let mut guard = self.session_slot(queue).lock().await;

    // If publishing fails on an existing cached session (for example, after a
    // broker restart), drop it, reconnect once, and retry unless delivery
    // outcome is already ambiguous.
    for attempt in 0..2_u8 {
      if self.shutting_down.load(Ordering::Acquire) {
        return Err(PublishError::ShuttingDown);
      }

      // Take ownership of the cached session before any `.await` so cancelling
      // this future under an outer timeout never leaves a half-used session cached.
      let (had_live_session, session) = match guard.take() {
        Some(session) if session.is_connected() => (true, session),
        Some(stale) => {
          tracing::info!(
            module = "nuq/rabbitmq",
            queue = queue.table_name(),
            "NuQ sender connection closed; reconnecting"
          );
          stale.close_gracefully("reconnect").await;
          let fresh = connect_and_declare(url.expose(), prefetch_queue, self.op_timeout).await?;
          (false, fresh)
        }
        None => {
          let fresh = connect_and_declare(url.expose(), prefetch_queue, self.op_timeout).await?;
          (false, fresh)
        }
      };

      match publish_once(
        &session.channel,
        routing_key,
        payload,
        properties.clone(),
        self.op_timeout,
      )
      .await
      {
        Ok(()) => {
          *guard = Some(session);
          return Ok(());
        }
        Err(err) => {
          session.close_gracefully("error").await;
          if err.is_ambiguous_outcome() {
            tracing::warn!(
              module = "nuq/rabbitmq",
              queue = queue.table_name(),
              error = %err,
              "NuQ sender publish timed out; delivery outcome is ambiguous so not retrying"
            );
            return Err(err);
          }
          if had_live_session && attempt == 0 {
            tracing::warn!(
              module = "nuq/rabbitmq",
              queue = queue.table_name(),
              error = %err,
              "NuQ sender publish failed on cached channel; reconnecting and retrying"
            );
            continue;
          }
          return Err(err);
        }
      }
    }

    Err(PublishError::Amqp(
      "publish exhausted reconnect attempts".to_owned(),
    ))
  }

  /// Gracefully closes both per-queue RabbitMQ channels and connections.
  pub async fn shutdown(&self) {
    self.shutting_down.store(true, Ordering::Release);
    let scrape = self.scrape_session.lock().await.take();
    let crawl_finished = self.crawl_finished_session.lock().await.take();

    let close_scrape = async {
      if let Some(session) = scrape {
        session.close_gracefully("shutdown").await;
      }
    };
    let close_crawl = async {
      if let Some(session) = crawl_finished {
        session.close_gracefully("shutdown").await;
      }
    };
    tokio::join!(close_scrape, close_crawl);
  }
}

async fn connect_and_declare(
  url: &str,
  prefetch_queue: &str,
  op_timeout: Duration,
) -> Result<AmqpSession, PublishError> {
  let connection = tokio::time::timeout(
    op_timeout,
    Connection::connect(
      url,
      ConnectionProperties::default().with_connection_name(CONNECTION_NAME.into()),
    ),
  )
  .await
  .map_err(|_| PublishError::Timeout("connect"))?
  .map_err(|err| PublishError::Amqp(err.to_string()))?;

  let channel = match tokio::time::timeout(op_timeout, connection.create_channel()).await {
    Ok(Ok(ch)) => ch,
    Ok(Err(err)) => {
      let _ =
        tokio::time::timeout(AMQP_CLOSE_TIMEOUT, connection.close(200, "cleanup".into())).await;
      return Err(PublishError::Amqp(err.to_string()));
    }
    Err(_) => {
      let _ =
        tokio::time::timeout(AMQP_CLOSE_TIMEOUT, connection.close(200, "cleanup".into())).await;
      return Err(PublishError::Timeout("create_channel"));
    }
  };

  let declare_res = tokio::time::timeout(
    op_timeout,
    channel.queue_declare(
      prefetch_queue.into(),
      QueueDeclareOptions {
        durable: true,
        ..QueueDeclareOptions::default()
      },
      prefetch_queue_args(),
    ),
  )
  .await;

  match declare_res {
    Ok(Ok(_)) => {}
    Ok(Err(err)) => {
      let session = AmqpSession {
        connection,
        channel,
      };
      session.close_gracefully("declare_failed").await;
      return Err(PublishError::Amqp(err.to_string()));
    }
    Err(_) => {
      let session = AmqpSession {
        connection,
        channel,
      };
      session.close_gracefully("declare_timeout").await;
      return Err(PublishError::Timeout("queue_declare"));
    }
  }

  // Enable publisher confirms so `basic_publish` awaits broker replication acks
  // on quorum queues instead of succeeding as soon as bytes hit the socket.
  let confirm_res = tokio::time::timeout(
    op_timeout,
    channel.confirm_select(ConfirmSelectOptions::default()),
  )
  .await;

  match confirm_res {
    Ok(Ok(())) => Ok(AmqpSession {
      connection,
      channel,
    }),
    Ok(Err(err)) => {
      let session = AmqpSession {
        connection,
        channel,
      };
      session.close_gracefully("confirm_select_failed").await;
      Err(PublishError::Amqp(err.to_string()))
    }
    Err(_) => {
      let session = AmqpSession {
        connection,
        channel,
      };
      session.close_gracefully("confirm_select_timeout").await;
      Err(PublishError::Timeout("confirm_select"))
    }
  }
}

async fn publish_once(
  channel: &Channel,
  routing_key: &str,
  payload: &[u8],
  properties: BasicProperties,
  op_timeout: Duration,
) -> Result<(), PublishError> {
  let confirm = tokio::time::timeout(
    op_timeout,
    channel.basic_publish(
      "".into(),
      routing_key.into(),
      BasicPublishOptions::default(),
      payload,
      properties,
    ),
  )
  .await
  .map_err(|_| PublishError::Timeout("basic_publish"))?
  .map_err(|err| PublishError::Amqp(err.to_string()))?;

  let confirmation = tokio::time::timeout(op_timeout, confirm)
    .await
    .map_err(|_| PublishError::ConfirmTimeout)?
    .map_err(|err| PublishError::ConfirmTransport(err.to_string()))?;

  match confirmation {
    Confirmation::Ack(_) => Ok(()),
    Confirmation::Nack(_) => Err(PublishError::Nacked),
    Confirmation::NotRequested => Err(PublishError::Amqp(
      "publisher confirms not enabled on AMQP channel".to_owned(),
    )),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn queue_args_and_publish_properties_match_nuq_ts() {
    let args = prefetch_queue_args();
    assert_eq!(
      args.inner().get("x-queue-type"),
      Some(&AMQPValue::LongString("quorum".into()))
    );
    assert_eq!(
      args.inner().get("x-max-length"),
      Some(&AMQPValue::LongInt(20_000))
    );

    let props = prefetch_publish_properties("job-123");
    assert_eq!(
      props.correlation_id().as_ref().map(|s| s.as_str()),
      Some("job-123")
    );
    assert_eq!(props.delivery_mode(), &Some(2));
    assert_eq!(
      props.expiration().as_ref().map(|s| s.as_str()),
      Some("50000")
    );
  }

  #[test]
  fn classifies_ambiguous_publish_timeouts_as_non_retryable() {
    assert!(PublishError::ConfirmTimeout.is_ambiguous_outcome());
    assert!(PublishError::ConfirmTransport("eof".to_owned()).is_ambiguous_outcome());
    assert!(PublishError::Timeout("basic_publish").is_ambiguous_outcome());
    assert!(!PublishError::Timeout("connect").is_ambiguous_outcome());
    assert!(!PublishError::Nacked.is_ambiguous_outcome());
    assert!(!PublishError::Amqp("reset".to_owned()).is_ambiguous_outcome());
  }
}
