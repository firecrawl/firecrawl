import amqp from "amqplib";
import { randomUUID } from "node:crypto";
import { config } from "../config";
import { logger as _logger } from "./logger";
import {
  recordSpanException,
  setSpanAttributes,
  withSpan,
} from "./otel-tracer";

const DELAY_MS = 24 * 60 * 60 * 1000;
const EXCHANGE = "zdr.cleanup";
const DELAY_QUEUE = "zdr.cleanup.delayed.24h";
const READY_QUEUE = "zdr.cleanup.ready";
const RETRY_QUEUE = "zdr.cleanup.retry";
const DLQ = "zdr.cleanup.dlq";
const READY_ROUTING_KEY = "ready";
const DLQ_ROUTING_KEY = "dead";
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 24;
const ATTEMPT_HEADER = "zdr-attempt";

const logger = _logger.child({ module: "zdr-queue" });

// A request-level job resolves its blobs from ClickHouse; a blob job names one blob.
export type ZdrCleanupJob = { requestId: string } | { blobId: string };

type CleanupHandler = (job: ZdrCleanupJob) => Promise<void>;

let connection: amqp.ChannelModel | null = null;
let connectionPromise: Promise<amqp.ChannelModel> | null = null;
let publishChannel: amqp.ConfirmChannel | null = null;
let publishChannelPromise: Promise<amqp.ConfirmChannel> | null = null;
let consumeChannel: amqp.Channel | null = null;
let consumeChannelPromise: Promise<amqp.Channel> | null = null;
let registeredHandler: CleanupHandler | null = null;
let subscribed = false;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectDelayMs = RECONNECT_BASE_DELAY_MS;
let closed = false;
const pendingPublishes = new WeakMap<
  amqp.ConfirmChannel,
  Map<string, { returned: boolean }>
>();

async function assertTopology(ch: amqp.Channel): Promise<void> {
  await ch.assertExchange(EXCHANGE, "direct", { durable: true });

  await ch.assertQueue(DLQ, {
    durable: true,
    arguments: {
      "x-queue-type": "quorum",
      "x-overflow": "reject-publish",
    },
  });
  await ch.bindQueue(DLQ, EXCHANGE, DLQ_ROUTING_KEY);

  await ch.assertQueue(READY_QUEUE, {
    durable: true,
    arguments: {
      "x-queue-type": "quorum",
      "x-overflow": "reject-publish",
      "x-delivery-limit": -1,
      "x-dead-letter-strategy": "at-least-once",
      "x-dead-letter-exchange": EXCHANGE,
      "x-dead-letter-routing-key": DLQ_ROUTING_KEY,
    },
  });
  await ch.bindQueue(READY_QUEUE, EXCHANGE, READY_ROUTING_KEY);

  await ch.assertQueue(DELAY_QUEUE, {
    durable: true,
    arguments: {
      "x-queue-type": "quorum",
      "x-overflow": "reject-publish",
      "x-message-ttl": DELAY_MS,
      "x-dead-letter-strategy": "at-least-once",
      "x-dead-letter-exchange": EXCHANGE,
      "x-dead-letter-routing-key": READY_ROUTING_KEY,
    },
  });

  await ch.assertQueue(RETRY_QUEUE, {
    durable: true,
    arguments: {
      "x-queue-type": "quorum",
      "x-overflow": "reject-publish",
      "x-message-ttl": RETRY_DELAY_MS,
      "x-dead-letter-strategy": "at-least-once",
      "x-dead-letter-exchange": EXCHANGE,
      "x-dead-letter-routing-key": READY_ROUTING_KEY,
    },
  });
}

function resetCachedState(): void {
  connection = null;
  connectionPromise = null;
  publishChannel = null;
  publishChannelPromise = null;
  consumeChannel = null;
  consumeChannelPromise = null;
  subscribed = false;
}

function handleConnectionDrop(reason: string, error?: unknown): void {
  if (connection || publishChannel || consumeChannel) {
    logger.warn("ZDR queue connection dropped", { reason, error });
  }
  resetCachedState();
  if (registeredHandler && !closed) scheduleReconnect();
}

function scheduleReconnect(): void {
  if (reconnectTimer || closed) return;

  const delayMs = reconnectDelayMs;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      if (registeredHandler) {
        const ch = await getConsumeChannel();
        if (closed) {
          await ch.close().catch(() => {});
          await connection?.close().catch(() => {});
          resetCachedState();
          return;
        }
        await subscribe(ch, registeredHandler);
      }
      reconnectDelayMs = RECONNECT_BASE_DELAY_MS;
      logger.info("ZDR queue reconnected; consumer re-subscribed");
    } catch (error) {
      logger.error("ZDR queue reconnect failed", { error, delayMs });
      resetCachedState();
      reconnectDelayMs = Math.min(delayMs * 2, RECONNECT_MAX_DELAY_MS);
      scheduleReconnect();
    }
  }, delayMs);
  reconnectTimer.unref?.();
}

async function getConnection(): Promise<amqp.ChannelModel> {
  if (connection) return connection;
  if (!connectionPromise) {
    connectionPromise = amqp
      .connect(config.NUQ_RABBITMQ_URL!, {
        clientProperties: { connection_name: "zdr-cleanup" },
      })
      .then(conn => {
        if (closed) {
          void conn.close().catch(() => {});
          throw new Error("ZDR queue closed while connecting");
        }
        connection = conn;
        conn.on("close", () => handleConnectionDrop("connection closed"));
        conn.on("error", error =>
          logger.error("ZDR queue connection error", { error }),
        );
        return conn;
      })
      .catch(error => {
        connectionPromise = null;
        throw error;
      });
  }
  return connectionPromise;
}

async function createPublishChannel(): Promise<amqp.ConfirmChannel> {
  const conn = await getConnection();
  const ch = await conn.createConfirmChannel();
  await assertTopology(ch);
  ch.on("close", () => {
    if (publishChannel === ch) {
      publishChannel = null;
      publishChannelPromise = null;
    }
  });
  ch.on("error", error => logger.error("ZDR publish channel error", { error }));
  const publishes = new Map<string, { returned: boolean }>();
  pendingPublishes.set(ch, publishes);
  ch.on("return", msg => {
    const correlationId = msg.properties.correlationId;
    if (correlationId) {
      const publish = publishes.get(correlationId);
      if (publish) publish.returned = true;
    }
  });
  return ch;
}

async function createConsumeChannel(): Promise<amqp.Channel> {
  const conn = await getConnection();
  const ch = await conn.createChannel();
  await assertTopology(ch);
  ch.on("close", () => {
    if (consumeChannel === ch) {
      consumeChannel = null;
      consumeChannelPromise = null;
      subscribed = false;
      if (!closed) scheduleReconnect();
    }
  });
  ch.on("error", error => logger.error("ZDR consume channel error", { error }));
  return ch;
}

async function getPublishChannel(): Promise<amqp.ConfirmChannel> {
  if (publishChannel) return publishChannel;
  if (!publishChannelPromise) {
    publishChannelPromise = createPublishChannel()
      .then(ch => {
        publishChannel = ch;
        return ch;
      })
      .catch(error => {
        publishChannelPromise = null;
        throw error;
      });
  }
  return publishChannelPromise;
}

async function getConsumeChannel(): Promise<amqp.Channel> {
  if (consumeChannel) return consumeChannel;
  if (!consumeChannelPromise) {
    consumeChannelPromise = createConsumeChannel()
      .then(ch => {
        consumeChannel = ch;
        return ch;
      })
      .catch(error => {
        consumeChannelPromise = null;
        throw error;
      });
  }
  return consumeChannelPromise;
}

function jobId(job: ZdrCleanupJob): string {
  return "blobId" in job ? job.blobId : job.requestId;
}

function publishConfirmed(
  ch: amqp.ConfirmChannel,
  queue: string,
  job: ZdrCleanupJob,
  attempt: number,
): Promise<void> {
  const correlationId = randomUUID();
  const publish = { returned: false };
  const publishes = pendingPublishes.get(ch);
  publishes?.set(correlationId, publish);

  return new Promise((resolve, reject) => {
    ch.sendToQueue(
      queue,
      Buffer.from(JSON.stringify(job)),
      {
        persistent: true,
        contentType: "application/json",
        messageId: jobId(job),
        correlationId,
        timestamp: Math.floor(Date.now() / 1000),
        mandatory: true,
        headers: { [ATTEMPT_HEADER]: attempt },
      },
      error => {
        setImmediate(() => {
          publishes?.delete(correlationId);
          if (error) reject(error);
          else if (publish.returned) {
            reject(new Error("RabbitMQ returned unroutable ZDR cleanup job"));
          } else resolve();
        });
      },
    );
  });
}

async function publishUntilConfirmed(
  queue: string,
  job: ZdrCleanupJob,
  attempt: number,
): Promise<void> {
  let delayMs = RECONNECT_BASE_DELAY_MS;
  while (!closed) {
    try {
      await withSpan("zdr.rabbitmq.publish", async span => {
        setSpanAttributes(span, {
          "messaging.system": "rabbitmq",
          "messaging.destination.name": queue,
          "messaging.operation.name": "publish",
          "messaging.message.id": jobId(job),
          "zdr.rabbitmq.retry_delay_ms": delayMs,
        });
        const ch = await getPublishChannel();
        await publishConfirmed(ch, queue, job, attempt);
        setSpanAttributes(span, {
          "zdr.rabbitmq.outcome": "confirmed",
        });
      });
      return;
    } catch (error) {
      logger.error("Failed to durably enqueue ZDR cleanup job; retrying", {
        error,
        queue,
        messageId: jobId(job),
        delayMs,
      });
      await publishChannel?.close().catch(() => {});
      publishChannel = null;
      publishChannelPromise = null;
      await new Promise(resolve => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, RECONNECT_MAX_DELAY_MS);
    }
  }

  throw new Error("ZDR queue closed before the cleanup job was confirmed");
}

/** Schedules a cleanup job 24 hours out, retrying until the broker confirms it. */
export async function enqueueZdrCleanupJob(job: ZdrCleanupJob): Promise<void> {
  if (!config.NUQ_RABBITMQ_URL) {
    throw new Error("NUQ_RABBITMQ_URL is not configured");
  }
  await publishUntilConfirmed(DELAY_QUEUE, job, 1);
}

function isZdrCleanupJob(value: unknown): value is ZdrCleanupJob {
  if (typeof value !== "object" || value === null) return false;
  const id =
    "blobId" in value
      ? value.blobId
      : "requestId" in value
        ? value.requestId
        : undefined;
  return typeof id === "string" && id.length > 0;
}

async function subscribe(
  ch: amqp.Channel,
  handler: CleanupHandler,
): Promise<void> {
  if (subscribed) return;
  await ch.prefetch(10);
  await ch.consume(
    READY_QUEUE,
    async msg => {
      if (!msg) {
        subscribed = false;
        scheduleReconnect();
        return;
      }
      const messageId = msg.properties.messageId;
      try {
        await withSpan("zdr.rabbitmq.consume", async span => {
          setSpanAttributes(span, {
            "messaging.system": "rabbitmq",
            "messaging.destination.name": READY_QUEUE,
            "messaging.operation.name": "process",
            "messaging.message.id": messageId,
            "messaging.rabbitmq.delivery_tag": msg.fields.deliveryTag,
            "messaging.rabbitmq.redelivered": msg.fields.redelivered,
          });

          let job: unknown;
          try {
            job = JSON.parse(msg.content.toString());
          } catch (error) {
            recordSpanException(span, error);
            setSpanAttributes(span, {
              "zdr.rabbitmq.outcome": "dead_lettered",
            });
            logger.error("Dead-lettering malformed ZDR cleanup job", { error });
            ch.nack(msg, false, false);
            return;
          }

          if (!isZdrCleanupJob(job)) {
            const error = new Error("Invalid ZDR cleanup job");
            recordSpanException(span, error);
            setSpanAttributes(span, {
              "zdr.rabbitmq.outcome": "dead_lettered",
            });
            logger.error("Dead-lettering invalid ZDR cleanup job", { job });
            ch.nack(msg, false, false);
            return;
          }

          const attempt = Number(msg.properties.headers?.[ATTEMPT_HEADER]) || 1;
          setSpanAttributes(span, {
            ...("blobId" in job
              ? { "zdr.blob_id": job.blobId }
              : { "zdr.request_id": job.requestId }),
            "zdr.attempt": attempt,
          });

          try {
            // An unsettled earlier delivery (worker died, channel closed) counts as a failed attempt.
            if (msg.fields.redelivered) {
              throw new Error("ZDR cleanup job was redelivered unsettled");
            }
            await handler(job);
          } catch (error) {
            recordSpanException(span, error);
            if (attempt >= MAX_ATTEMPTS) {
              logger.error(
                "ZDR cleanup job failed its last attempt; dead-lettering",
                {
                  error,
                  messageId,
                  attempt,
                },
              );
              ch.nack(msg, false, false);
              setSpanAttributes(span, {
                "zdr.rabbitmq.outcome": "dead_lettered",
              });
              return;
            }
            logger.warn("ZDR cleanup job failed; scheduling a retry", {
              error,
              messageId,
              attempt,
              retryDelayMs: RETRY_DELAY_MS,
            });
            await publishUntilConfirmed(RETRY_QUEUE, job, attempt + 1);
            ch.ack(msg);
            setSpanAttributes(span, {
              "zdr.rabbitmq.outcome": "retry_scheduled",
            });
            return;
          }

          ch.ack(msg);
          setSpanAttributes(span, {
            "zdr.rabbitmq.outcome": "acknowledged",
          });
        });
      } catch (error) {
        // Left unacked, the broker redelivers it once this channel closes.
        logger.error("Could not settle ZDR cleanup job", { error, messageId });
      }
    },
    { noAck: false },
  );
  subscribed = true;
  logger.info("Started consuming ZDR cleanup jobs");
}

export async function consumeZdrCleanupJobs(
  handler: CleanupHandler,
): Promise<void> {
  registeredHandler = handler;
  closed = false;
  try {
    const ch = await getConsumeChannel();
    if (closed) {
      await ch.close().catch(() => {});
      await connection?.close().catch(() => {});
      resetCachedState();
      return;
    }
    await subscribe(ch, handler);
  } catch (error) {
    if (closed) return;
    logger.error("Failed to start ZDR queue consumer; retrying", { error });
    resetCachedState();
    scheduleReconnect();
  }
}

export async function shutdownZdrQueue(): Promise<void> {
  closed = true;
  registeredHandler = null;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  await publishChannel?.close().catch(() => {});
  await consumeChannel?.close().catch(() => {});
  await connection?.close().catch(() => {});
  resetCachedState();
}
