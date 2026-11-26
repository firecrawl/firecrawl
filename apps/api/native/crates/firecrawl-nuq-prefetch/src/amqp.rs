//! RabbitMQ prefetch publisher matching `NuQ::startSender` and `NuQ::sendJobPrefetch`
//! in `apps/api/src/services/worker/nuq.ts`.

use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use lapin::options::{BasicPublishOptions, QueueDeclareOptions};
use lapin::types::{AMQPValue, FieldTable};
use lapin::{BasicProperties, Channel, Connection, ConnectionProperties};
use thiserror::Error;
use tokio::sync::Mutex;

use crate::config::{RedactedString, redact_amqp_url};
use crate::job::{NuqJob, QueueKind};

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
  #[error("publisher is shutting down")]
  ShuttingDown,
  #[error("failed to serialize job payload: {0}")]
  Serialize(String),
  #[error("AMQP operation timed out: {0}")]
  Timeout(&'static str),
  #[error("AMQP operation failed: {0}")]
  Amqp(String),
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
  /// Creates a publisher for an optional `NUQ_RABBITMQ_URL`.
  ///
  /// When `None`, `send_job` logs a warning without crashing, matching `nuq.ts`.
  #[must_use]
  pub fn new(rabbitmq_url: Option<RedactedString>) -> Self {
    firecrawl_core::telemetry::ensure_crypto_provider();
    Self {
      rabbitmq_url,
      scrape_session: Mutex::new(None),
      crawl_finished_session: Mutex::new(None),
      shutting_down: AtomicBool::new(false),
    }
  }

  fn session_slot(&self, queue: QueueKind) -> &Mutex<Option<AmqpSession>> {
    match queue {
      QueueKind::Scrape => &self.scrape_session,
      QueueKind::CrawlFinished => &self.crawl_finished_session,
    }
  }

  /// Publishes a single prefetched job to `<queueName>.prefetch`.
  pub async fn send_job(&self, queue: QueueKind, job: &NuqJob) -> Result<(), PublishError> {
    let Some(url) = self.rabbitmq_url.as_ref() else {
      tracing::warn!(
        module = "nuq/rabbitmq",
        queue = queue.table_name(),
        "NuQ sender not started"
      );
      return Ok(());
    };

    if self.shutting_down.load(Ordering::Acquire) {
      return Err(PublishError::ShuttingDown);
    }

    let payload =
      serde_json::to_vec(job).map_err(|err| PublishError::Serialize(err.to_string()))?;
    let routing_key = queue.prefetch_queue_name();
    let properties = prefetch_publish_properties(&job.id);

    let mut guard = self.session_slot(queue).lock().await;

    // If publishing fails on an existing cached session (for example, after a
    // broker restart), drop it, reconnect once, and retry the publish.
    for attempt in 0..2_u8 {
      if self.shutting_down.load(Ordering::Acquire) {
        return Err(PublishError::ShuttingDown);
      }

      let had_live_session = match guard.as_ref() {
        Some(session) if session.is_connected() => true,
        Some(_) => {
          if let Some(stale) = guard.take() {
            tracing::info!(
              module = "nuq/rabbitmq",
              queue = queue.table_name(),
              "NuQ sender connection closed; reconnecting"
            );
            stale.close_gracefully("reconnect").await;
          }
          false
        }
        None => false,
      };

      if guard.is_none() {
        let session = connect_and_declare(url.expose(), routing_key).await?;
        *guard = Some(session);
      }

      let Some(session) = guard.as_ref() else {
        return Err(PublishError::Amqp("missing AMQP session".to_owned()));
      };

      match publish_once(&session.channel, routing_key, &payload, properties.clone()).await {
        Ok(()) => {
          if !job.is_zero_data_retention() {
            tracing::info!(
              module = "nuq/rabbitmq",
              queue = queue.table_name(),
              job_id = %job.id,
              "NuQ job prefetch sent"
            );
          }
          return Ok(());
        }
        Err(err) => {
          if let Some(dead) = guard.take() {
            dead.close_gracefully("error").await;
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

async fn connect_and_declare(url: &str, prefetch_queue: &str) -> Result<AmqpSession, PublishError> {
  let connection = tokio::time::timeout(
    AMQP_OP_TIMEOUT,
    Connection::connect(
      url,
      ConnectionProperties::default().with_connection_name(CONNECTION_NAME.into()),
    ),
  )
  .await
  .map_err(|_| PublishError::Timeout("connect"))?
  .map_err(|err| PublishError::Amqp(err.to_string()))?;

  let channel = match tokio::time::timeout(AMQP_OP_TIMEOUT, connection.create_channel()).await {
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
    AMQP_OP_TIMEOUT,
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
    Ok(Ok(_)) => Ok(AmqpSession {
      connection,
      channel,
    }),
    Ok(Err(err)) => {
      let session = AmqpSession {
        connection,
        channel,
      };
      session.close_gracefully("declare_failed").await;
      Err(PublishError::Amqp(err.to_string()))
    }
    Err(_) => {
      let session = AmqpSession {
        connection,
        channel,
      };
      session.close_gracefully("declare_timeout").await;
      Err(PublishError::Timeout("queue_declare"))
    }
  }
}

async fn publish_once(
  channel: &Channel,
  routing_key: &str,
  payload: &[u8],
  properties: BasicProperties,
) -> Result<(), PublishError> {
  let confirm = tokio::time::timeout(
    AMQP_OP_TIMEOUT,
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

  tokio::time::timeout(AMQP_OP_TIMEOUT, confirm)
    .await
    .map_err(|_| PublishError::Timeout("publish_confirm"))?
    .map_err(|err| PublishError::Amqp(err.to_string()))?;

  Ok(())
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
}
