import amqp from "amqplib";
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
const DLQ = "zdr.cleanup.dlq";
const READY_ROUTING_KEY = "ready";
const DLQ_ROUTING_KEY = "dead";
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

const logger = _logger.child({ module: "zdr-queue" });

type ZdrCleanupJob = {
  requestId: string;
};

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

function publishConfirmed(
  ch: amqp.ConfirmChannel,
  job: ZdrCleanupJob,
): Promise<void> {
  return new Promise((resolve, reject) => {
    ch.sendToQueue(
      DELAY_QUEUE,
      Buffer.from(JSON.stringify(job)),
      {
        persistent: true,
        contentType: "application/json",
        messageId: job.requestId,
        timestamp: Math.floor(Date.now() / 1000),
        mandatory: true,
      },
      error => (error ? reject(error) : resolve()),
    );
  });
}

export async function enqueueZdrCleanupJob(requestId: string): Promise<void> {
  if (!config.NUQ_RABBITMQ_URL) {
    throw new Error("NUQ_RABBITMQ_URL is not configured");
  }

  let delayMs = RECONNECT_BASE_DELAY_MS;
  while (!closed) {
    try {
      await withSpan("zdr.rabbitmq.publish", async span => {
        setSpanAttributes(span, {
          "messaging.system": "rabbitmq",
          "messaging.destination.name": DELAY_QUEUE,
          "messaging.operation.name": "publish",
          "messaging.message.id": requestId,
          "zdr.rabbitmq.retry_delay_ms": delayMs,
        });
        const ch = await getPublishChannel();
        await publishConfirmed(ch, { requestId });
        setSpanAttributes(span, {
          "zdr.rabbitmq.outcome": "confirmed",
        });
      });
      return;
    } catch (error) {
      logger.error("Failed to durably enqueue ZDR cleanup job; retrying", {
        error,
        requestId,
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

function isZdrCleanupJob(value: unknown): value is ZdrCleanupJob {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<ZdrCleanupJob>).requestId === "string" &&
    (value as ZdrCleanupJob).requestId.length > 0
  );
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
      try {
        await withSpan("zdr.rabbitmq.consume", async span => {
          setSpanAttributes(span, {
            "messaging.system": "rabbitmq",
            "messaging.destination.name": READY_QUEUE,
            "messaging.operation.name": "process",
            "messaging.message.id": msg.properties.messageId,
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

          setSpanAttributes(span, {
            "zdr.request_id": job.requestId,
          });
          await handler(job);
          ch.ack(msg);
          setSpanAttributes(span, {
            "zdr.rabbitmq.outcome": "acknowledged",
          });
        });
      } catch (error) {
        logger.error("ZDR cleanup job failed; requeueing", {
          error,
          messageId: msg.properties.messageId,
        });
        ch.nack(msg, false, true);
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
    await subscribe(ch, handler);
  } catch (error) {
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
