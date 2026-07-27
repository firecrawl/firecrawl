// RabbitMQ transport for SIEM audit delivery.
//
// Why RabbitMQ and not the BullMQ queues next door: this queue turns one message
// per scrape into an outbound HTTPS call, so it needs two things Redis/BullMQ
// cannot express. First a hard bound — x-max-length with drop-head caps the
// backlog in the broker, so a destination outage can never grow it without limit
// and starve the workers. Second real batching — prefetch plus manual ack lets a
// consumer hold many messages, group them by organization, and deliver one gzip
// batch per org instead of one authenticated POST per scrape.
//
// Retries ride a fixed-delay ladder (x-message-ttl queues that dead-letter back
// onto the main queue) because the cluster does not load
// rabbitmq_delayed_message_exchange. Fixed per-queue TTLs also avoid the
// head-of-line blocking that per-message TTLs would introduce.

import amqp from "amqplib";
import { config } from "../../config";
import { logger as _logger } from "../logger";
import { siemLoggingEventsTotal } from "./metrics";
import type { ScrapeActivityEvent, SiemLoggingMessage } from "./types";

const EXCHANGE = "siem.logging";
const QUEUE = "siem.logging.events";
const RETRY_EXCHANGE = "siem.logging.retry";
const DLX = "siem.logging.dlx";
const DLQ = "siem.logging.dlq";

// ~36 minutes of destination downtime before an event dead-letters. The sender
// already makes three in-process attempts per call, so these rungs cover
// outages, not blips.
const RETRY_DELAYS_MS = [5_000, 30_000, 300_000, 1_800_000] as const;

// Hard backlog bound, enforced by the broker. An outage costs the oldest slice
// of the audit trail instead of the workers' memory; queue depth and the drop
// counters are scraped from rabbitmq_prometheus for alerting.
const MAX_QUEUED_MESSAGES = 100_000;

// A batch closes on whichever comes first. The linger is what turns per-scrape
// messages into per-org batches; keep it short enough that a quiet org still
// sees its audit events land promptly.
const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_BATCH_LINGER_MS = 1_000;

const logger = _logger.child({ module: "siem-logging-transport" });

export type SiemLoggingBatchOutcome = {
  /** "done" acks the batch, "retry" moves it to the next rung, "drop" dead-letters it. */
  disposition: "done" | "retry" | "drop";
  /** Earliest acceptable retry delay in ms — honors a destination's Retry-After. */
  retryAfterMs?: number;
};

/**
 * Deliver one organization's events. The batch shares a single fate because it
 * maps to one authenticated call against that org's destination.
 */
export type SiemLoggingBatchHandler = (
  orgId: string,
  events: ScrapeActivityEvent[],
) => Promise<SiemLoggingBatchOutcome>;

export interface SiemLoggingConsumerOptions {
  /** Unacked message budget; also the ceiling on how large a batch can grow. */
  prefetch?: number;
  batchSize?: number;
  batchLingerMs?: number;
}

let connection: amqp.ChannelModel | null = null;
// Memoized so concurrent callers share one connect() instead of racing to open
// (and orphan) duplicate connections.
let connectionPromise: Promise<amqp.ChannelModel> | null = null;
// Separate publish/consume channels so an exception on one can't tear down the other.
// Publishing goes through a confirm channel: emission is already fire-and-forget
// off the scrape path, so waiting for the broker to acknowledge each event costs
// the caller nothing and is the difference between a complete audit record and
// one with silent holes in it.
let publishChannel: amqp.ConfirmChannel | null = null;
let consumeChannel: amqp.Channel | null = null;
let publishChannelPromise: Promise<amqp.ConfirmChannel> | null = null;
let consumeChannelPromise: Promise<amqp.Channel> | null = null;

// Registered so a reconnect can re-attach the consumer; index-worker replicas
// never publish, so without this they go permanently deaf after a broker blip.
let registeredHandler: SiemLoggingBatchHandler | null = null;
let registeredOptions: SiemLoggingConsumerOptions = {};
let subscribed = false;
let reconnectInFlight = false;
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30_000;

function retryQueueName(delayMs: number): string {
  return `${QUEUE}.retry.${delayMs}`;
}

async function assertTopology(ch: amqp.Channel): Promise<void> {
  await ch.assertExchange(EXCHANGE, "direct", { durable: true });
  await ch.assertExchange(RETRY_EXCHANGE, "direct", { durable: true });
  await ch.assertExchange(DLX, "direct", { durable: true });

  await ch.assertQueue(DLQ, { durable: true });
  await ch.bindQueue(DLQ, DLX, QUEUE);

  // Classic, not quorum like the monitoring queues: x-max-length with drop-head
  // is the bound this queue exists to have, and classic queues support that
  // combination on every broker version we might be running. The cost is that a
  // node loss drops this queue's backlog — acceptable for a buffer that already
  // sheds its oldest events at the cap, and cheaper than a declaration that
  // fails with PRECONDITION_FAILED and takes all delivery down with it.
  await ch.assertQueue(QUEUE, {
    durable: true,
    arguments: {
      "x-max-length": MAX_QUEUED_MESSAGES,
      "x-overflow": "drop-head",
      "x-dead-letter-exchange": DLX,
      "x-dead-letter-routing-key": QUEUE,
    },
  });
  await ch.bindQueue(QUEUE, EXCHANGE, QUEUE);

  // Each rung parks messages for a fixed TTL, then dead-letters them back onto
  // the main queue. The same bound applies, so a wedged destination can't turn
  // the retry ladder into unbounded storage either.
  for (const delayMs of RETRY_DELAYS_MS) {
    const queue = retryQueueName(delayMs);
    await ch.assertQueue(queue, {
      durable: true,
      arguments: {
        "x-message-ttl": delayMs,
        "x-max-length": MAX_QUEUED_MESSAGES,
        "x-overflow": "drop-head",
        "x-dead-letter-exchange": EXCHANGE,
        "x-dead-letter-routing-key": QUEUE,
      },
    });
    await ch.bindQueue(queue, RETRY_EXCHANGE, queue);
  }
}

function resetCachedState(): void {
  connection = null;
  connectionPromise = null;
  publishChannel = null;
  publishChannelPromise = null;
  consumeChannel = null;
  consumeChannelPromise = null;
  subscribed = false;
  abandonPendingBatches();
}

function handleConnectionDrop(reason: string, error?: unknown): void {
  if (connection || publishChannel || consumeChannel) {
    logger.warn("SIEM logging transport dropped — will reconnect", {
      reason,
      error,
    });
  }
  resetCachedState();
  if (registeredHandler) scheduleReconnect(RECONNECT_BASE_DELAY_MS);
}

function scheduleReconnect(delayMs: number): void {
  if (reconnectInFlight) return;
  reconnectInFlight = true;

  setTimeout(async () => {
    try {
      const ch = await getConsumeChannel();
      if (registeredHandler) {
        await subscribe(ch, registeredHandler, registeredOptions);
      }
      reconnectInFlight = false;
      logger.info("SIEM logging transport reconnected; consumer re-subscribed");
    } catch (error) {
      reconnectInFlight = false;
      const nextDelay = Math.min(delayMs * 2, RECONNECT_MAX_DELAY_MS);
      logger.error("SIEM logging transport reconnect failed; retrying", {
        error,
        nextDelayMs: nextDelay,
      });
      // A mid-subscribe failure on a healthy channel never fires "close", so
      // reset everything or the next attempt short-circuits and stays deaf.
      await consumeChannel?.close().catch(() => {});
      resetCachedState();
      scheduleReconnect(nextDelay);
    }
  }, delayMs).unref?.();
}

async function openConnection(): Promise<amqp.ChannelModel> {
  const url = config.NUQ_RABBITMQ_URL;
  if (!url) throw new Error("NUQ_RABBITMQ_URL is not configured");

  const conn = await amqp.connect(url, {
    clientProperties: { connection_name: "siem-logging" },
  });
  conn.on("close", () => handleConnectionDrop("connection closed"));
  conn.on("error", error =>
    logger.error("SIEM logging transport connection error", { error }),
  );
  return conn;
}

async function getConnection(): Promise<amqp.ChannelModel> {
  if (connection) return connection;
  if (!connectionPromise) {
    connectionPromise = openConnection()
      .then(conn => {
        connection = conn;
        return conn;
      })
      .catch(error => {
        connectionPromise = null;
        throw error;
      });
  }
  return connectionPromise;
}

async function createChannel(label: "publish"): Promise<amqp.ConfirmChannel>;
async function createChannel(label: "consume"): Promise<amqp.Channel>;
async function createChannel(
  label: "publish" | "consume",
): Promise<amqp.Channel | amqp.ConfirmChannel> {
  const conn = await getConnection();
  const ch =
    label === "publish"
      ? await conn.createConfirmChannel()
      : await conn.createChannel();
  await assertTopology(ch);
  // Channels can close independently of the connection (e.g. PRECONDITION_FAILED);
  // without this the cached channel stays non-null and every call throws forever.
  ch.on("close", () => {
    if (label === "publish" && publishChannel === ch) {
      publishChannel = null;
      publishChannelPromise = null;
    }
    if (label === "consume" && consumeChannel === ch) {
      consumeChannel = null;
      consumeChannelPromise = null;
      subscribed = false;
      handleConnectionDrop("consume channel closed");
    }
  });
  ch.on("error", error =>
    logger.error("SIEM logging transport channel error", { label, error }),
  );
  return ch;
}

async function getPublishChannel(): Promise<amqp.ConfirmChannel> {
  if (publishChannel) return publishChannel;
  if (!publishChannelPromise) {
    publishChannelPromise = createChannel("publish")
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
    consumeChannelPromise = createChannel("consume")
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

// Resolves once the broker has taken responsibility for the message, and rejects
// if it nacks instead. Note this says nothing about routing: an unroutable
// publish is still confirmed, so the queue bindings above are what keep events
// from being silently discarded by the exchange.
function publishConfirmed(
  ch: amqp.ConfirmChannel,
  exchange: string,
  routingKey: string,
  content: Buffer,
  options: amqp.Options.Publish,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const sent = ch.publish(exchange, routingKey, content, options, error =>
      error ? reject(error) : resolve(),
    );
    // A false return only means the socket write buffer is full; the message is
    // still queued client-side and the confirm callback still fires.
    if (!sent) siemLoggingEventsTotal.inc({ result: "publish_backpressure" });
  });
}

export async function enqueueSiemLoggingEvent(
  orgId: string,
  event: ScrapeActivityEvent,
): Promise<void> {
  await enqueueSiemLoggingEvents(orgId, [event]);
}

export async function enqueueSiemLoggingEvents(
  orgId: string,
  events: ScrapeActivityEvent[],
): Promise<void> {
  if (events.length === 0) return;
  try {
    const ch = await getPublishChannel();
    await Promise.all(
      events.map(event =>
        publishConfirmed(
          ch,
          EXCHANGE,
          QUEUE,
          Buffer.from(
            JSON.stringify({ orgId, event } satisfies SiemLoggingMessage),
          ),
          {
            persistent: true,
            contentType: "application/json",
            messageId: event.scrape_id,
            headers: { "x-siem-attempt": 0 },
          },
        ),
      ),
    );
    siemLoggingEventsTotal.inc({ result: "queued" }, events.length);
  } catch (error) {
    siemLoggingEventsTotal.inc({ result: "enqueue_failed" }, events.length);
    throw error;
  }
}

/** Smallest ladder rung that is at least `minDelayMs`, else the largest rung. */
function rungForDelay(minDelayMs: number | undefined): number {
  if (minDelayMs === undefined || minDelayMs <= 0) return RETRY_DELAYS_MS[0];
  return (
    RETRY_DELAYS_MS.find(delay => delay >= minDelayMs) ??
    RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]
  );
}

function attemptOf(msg: amqp.ConsumeMessage): number {
  const raw = msg.properties.headers?.["x-siem-attempt"];
  const attempt = typeof raw === "number" ? raw : Number(raw ?? 0);
  return Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
}

// Republish onto a delay rung, then ack the original: a plain nack-with-requeue
// redelivers immediately and would spin against a destination that is still down.
// The republish is confirmed before the caller acks, so the window where the
// original is gone and the retry never landed stays closed.
async function scheduleRetry(
  msg: amqp.ConsumeMessage,
  retryAfterMs: number | undefined,
): Promise<boolean> {
  const attempt = attemptOf(msg);
  if (attempt >= RETRY_DELAYS_MS.length) return false;
  // Never step backwards down the ladder on a repeat failure.
  const delayMs = Math.max(
    rungForDelay(retryAfterMs),
    RETRY_DELAYS_MS[attempt],
  );
  const ch = await getPublishChannel();
  await publishConfirmed(
    ch,
    RETRY_EXCHANGE,
    retryQueueName(delayMs),
    msg.content,
    {
      persistent: true,
      contentType: "application/json",
      messageId: msg.properties.messageId,
      headers: { "x-siem-attempt": attempt + 1 },
    },
  );
  return true;
}

interface PendingBatch {
  messages: amqp.ConsumeMessage[];
  events: ScrapeActivityEvent[];
  timer: NodeJS.Timeout;
}

// Valid JSON is not a valid message: without this, a body missing orgId would
// open a batch keyed on undefined and send the handler looking up a destination
// for an organization that doesn't exist.
function isSiemLoggingMessage(value: unknown): value is SiemLoggingMessage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<SiemLoggingMessage>;
  return (
    typeof candidate.orgId === "string" &&
    candidate.orgId.length > 0 &&
    typeof candidate.event === "object" &&
    candidate.event !== null
  );
}

// One open batch per organization: each org has its own destination, credentials
// and token, so batches can never span orgs.
const pendingBatches = new Map<string, PendingBatch>();

function abandonPendingBatches(): void {
  for (const batch of pendingBatches.values()) clearTimeout(batch.timer);
  // Left unacked on purpose — the broker redelivers them to a live consumer.
  pendingBatches.clear();
}

async function applyOutcome(
  ch: amqp.Channel,
  batch: PendingBatch,
  outcome: SiemLoggingBatchOutcome,
): Promise<void> {
  if (outcome.disposition === "done") {
    for (const msg of batch.messages) ch.ack(msg);
    return;
  }
  if (outcome.disposition === "drop") {
    for (const msg of batch.messages) ch.nack(msg, false, false);
    siemLoggingEventsTotal.inc(
      { result: "dead_lettered" },
      batch.messages.length,
    );
    return;
  }
  let retried = 0;
  let deadLettered = 0;
  for (const msg of batch.messages) {
    if (await scheduleRetry(msg, outcome.retryAfterMs)) {
      ch.ack(msg);
      retried++;
    } else {
      ch.nack(msg, false, false);
      deadLettered++;
    }
  }
  if (retried > 0) siemLoggingEventsTotal.inc({ result: "retried" }, retried);
  if (deadLettered > 0) {
    siemLoggingEventsTotal.inc({ result: "dead_lettered" }, deadLettered);
  }
}

async function flushBatch(
  ch: amqp.Channel,
  handler: SiemLoggingBatchHandler,
  orgId: string,
): Promise<void> {
  const batch = pendingBatches.get(orgId);
  if (!batch) return;
  pendingBatches.delete(orgId);
  clearTimeout(batch.timer);

  let outcome: SiemLoggingBatchOutcome;
  try {
    outcome = await handler(orgId, batch.events);
  } catch (error) {
    logger.error("SIEM logging batch handler threw", {
      error,
      orgId,
      events: batch.events.length,
    });
    outcome = { disposition: "retry" };
  }

  try {
    await applyOutcome(ch, batch, outcome);
  } catch (error) {
    // The channel died mid-batch, or a retry republish was nacked; either way
    // the broker redelivers everything still unacked.
    logger.warn("Failed to settle a SIEM logging batch", { error, orgId });
  }
}

async function subscribe(
  ch: amqp.Channel,
  handler: SiemLoggingBatchHandler,
  options: SiemLoggingConsumerOptions,
): Promise<void> {
  if (subscribed) return;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const lingerMs = options.batchLingerMs ?? DEFAULT_BATCH_LINGER_MS;
  // A batch can only ever hold messages the broker has handed us, so prefetch
  // has to leave room for a full batch or it caps the batch below batchSize.
  await ch.prefetch(options.prefetch ?? batchSize * 2, false);

  await ch.consume(
    QUEUE,
    async msg => {
      if (!msg) return;

      let message: SiemLoggingMessage;
      try {
        const parsed: unknown = JSON.parse(msg.content.toString());
        if (!isSiemLoggingMessage(parsed)) {
          throw new Error("Message is not a SIEM logging event");
        }
        message = parsed;
      } catch (error) {
        logger.error("Failed to parse SIEM logging message", { error });
        siemLoggingEventsTotal.inc({ result: "unparseable" });
        ch.nack(msg, false, false);
        return;
      }

      const orgId = message.orgId;
      let batch = pendingBatches.get(orgId);
      if (!batch) {
        batch = {
          messages: [],
          events: [],
          timer: setTimeout(() => {
            void flushBatch(ch, handler, orgId);
          }, lingerMs),
        };
        batch.timer.unref?.();
        pendingBatches.set(orgId, batch);
      }
      batch.messages.push(msg);
      batch.events.push(message.event);

      if (batch.events.length >= batchSize) {
        await flushBatch(ch, handler, orgId);
      }
    },
    { noAck: false },
  );

  subscribed = true;
  logger.info("Started consuming SIEM logging events", {
    queue: QUEUE,
    batchSize,
    lingerMs,
  });
}

export async function consumeSiemLoggingEvents(
  handler: SiemLoggingBatchHandler,
  options: SiemLoggingConsumerOptions = {},
): Promise<void> {
  registeredHandler = handler;
  registeredOptions = options;
  const ch = await getConsumeChannel();
  await subscribe(ch, handler, options);
}

export async function closeSiemLoggingTransport(): Promise<void> {
  registeredHandler = null;
  const conn = connection;
  resetCachedState();
  await conn?.close().catch(() => {});
}
