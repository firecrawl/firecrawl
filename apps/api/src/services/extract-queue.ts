import amqp from "amqplib";
import { randomUUID } from "node:crypto";
import { config } from "../config";
import { logger as _logger } from "../lib/logger";

const EXTRACT_QUEUE = "extract.jobs";
const EXTRACT_DLX = "extract.dlx";
const EXTRACT_DLQ = "extract.dlq";
const PUBLISH_CONFIRM_TIMEOUT_MS = 10_000;

export type ExtractJobData = {
  extractId: string;
  request: any;
  teamId: string;
  apiKeyId?: number | null;
  agent?: any;
  createdAt: number;
  /** The caller's External-Request-Id, carried on the extract charge. */
  externalRequestId?: string | null;
};

let connection: amqp.ChannelModel | null = null;
let channel: amqp.ConfirmChannel | null = null;
let channelPromise: Promise<amqp.ConfirmChannel> | null = null;
const pendingPublishes = new Map<
  string,
  { returned: boolean; reject: (error: Error) => void }
>();

function rejectPendingPublishes(error: Error): void {
  for (const pending of pendingPublishes.values()) pending.reject(error);
  pendingPublishes.clear();
}

async function getChannel(): Promise<amqp.ConfirmChannel> {
  if (channel) return channel;
  if (channelPromise) return channelPromise;

  channelPromise = openChannel();
  try {
    return await channelPromise;
  } finally {
    channelPromise = null;
  }
}

async function openChannel(): Promise<amqp.ConfirmChannel> {
  const url = config.NUQ_RABBITMQ_URL;
  if (!url) {
    throw new Error("NUQ_RABBITMQ_URL is not configured");
  }

  const conn = await amqp.connect(url);
  let ch: amqp.ConfirmChannel;
  try {
    ch = await conn.createConfirmChannel();

    // Set up the dead letter exchange
    await ch.assertExchange(EXTRACT_DLX, "direct", { durable: true });

    // Set up the dead letter queue
    await ch.assertQueue(EXTRACT_DLQ, {
      durable: true,
      arguments: {
        "x-queue-type": "quorum",
      },
    });
    await ch.bindQueue(EXTRACT_DLQ, EXTRACT_DLX, EXTRACT_QUEUE);

    // Set up the main queue with DLX - no retries (messages go straight to DLQ on reject/crash)
    await ch.assertQueue(EXTRACT_QUEUE, {
      durable: true,
      arguments: {
        "x-queue-type": "quorum",
        "x-dead-letter-exchange": EXTRACT_DLX,
        "x-dead-letter-routing-key": EXTRACT_QUEUE,
        "x-delivery-limit": 1,
      },
    });
  } catch (error) {
    await conn.close().catch(() => {});
    throw error;
  }

  ch.on("return", msg => {
    const correlationId = msg.properties.correlationId;
    const pending = pendingPublishes.get(correlationId);
    if (pending) pending.returned = true;
  });

  conn.on("close", () => {
    _logger.warn("Extract queue connection closed");
    if (connection === conn) {
      connection = null;
      channel = null;
      rejectPendingPublishes(new Error("Extract queue connection closed"));
    }
  });

  conn.on("error", err => {
    _logger.error("Extract queue connection error", { error: err });
  });

  ch.on("close", () => {
    if (channel === ch) {
      channel = null;
      connection = null;
      rejectPendingPublishes(new Error("Extract queue channel closed"));
      void conn.close().catch(() => {});
    }
  });
  ch.on("error", err => {
    _logger.error("Extract queue channel error", { error: err });
  });

  connection = conn;
  channel = ch;
  return ch;
}

export async function addExtractJob(
  extractId: string,
  data: ExtractJobData,
): Promise<void> {
  const ch = await getChannel();
  const correlationId = randomUUID();
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingPublishes
        .get(correlationId)
        ?.reject(new Error("Extract job publish confirmation timed out"));
    }, PUBLISH_CONFIRM_TIMEOUT_MS);
    pendingPublishes.set(correlationId, {
      returned: false,
      reject: error => {
        clearTimeout(timeout);
        pendingPublishes.delete(correlationId);
        reject(error);
      },
    });

    try {
      const writable = ch.sendToQueue(
        EXTRACT_QUEUE,
        Buffer.from(JSON.stringify(data)),
        {
          persistent: true,
          messageId: extractId,
          correlationId,
          mandatory: true,
        },
        error => {
          // RabbitMQ emits basic.return before the publisher confirmation.
          setImmediate(() => {
            const pending = pendingPublishes.get(correlationId);
            if (!pending) return;
            clearTimeout(timeout);
            pendingPublishes.delete(correlationId);
            if (error) reject(error);
            else if (pending.returned)
              reject(new Error("RabbitMQ returned unroutable extract job"));
            else resolve();
          });
        },
      );
      if (!writable) {
        // A full client write buffer is backpressure, not an enqueue failure.
        // The publisher confirmation remains the authoritative result.
        _logger.warn("Extract job publish buffer full", { extractId });
      }
    } catch (error) {
      pendingPublishes.get(correlationId)?.reject(error as Error);
    }
  });
  _logger.info("Extract job added to queue", { extractId });
}

export async function consumeExtractJobs(
  handler: (
    data: ExtractJobData,
    ack: () => void,
    nack: () => void,
  ) => Promise<void>,
): Promise<void> {
  const ch = await getChannel();
  await ch.prefetch(1);

  await ch.consume(
    EXTRACT_QUEUE,
    async msg => {
      if (!msg) return;

      const data = JSON.parse(msg.content.toString()) as ExtractJobData;
      const logger = _logger.child({
        module: "extract-queue",
        extractId: data.extractId,
      });

      logger.info("Processing extract job");

      try {
        await handler(
          data,
          () => ch.ack(msg),
          () => ch.nack(msg, false, false), // Don't requeue - send to DLX
        );
      } catch (error) {
        logger.error("Extract job handler threw an error", { error });
        // Don't requeue - send to DLX
        ch.nack(msg, false, false);
      }
    },
    { noAck: false },
  );

  _logger.info("Started consuming extract jobs");
}

export async function consumeExtractDLQ(
  handler: (data: ExtractJobData) => Promise<void>,
): Promise<void> {
  const ch = await getChannel();
  await ch.prefetch(1);

  await ch.consume(
    EXTRACT_DLQ,
    async msg => {
      if (!msg) return;

      const data = JSON.parse(msg.content.toString()) as ExtractJobData;
      const logger = _logger.child({
        module: "extract-dlq",
        extractId: data.extractId,
      });

      logger.info("Processing dead-lettered extract job");

      try {
        await handler(data);
        ch.ack(msg);
      } catch (error) {
        logger.error("DLQ handler threw an error, requeueing", { error });
        // Requeue DLQ messages on error so we don't lose them
        ch.nack(msg, false, true);
      }
    },
    { noAck: false },
  );

  _logger.info("Started consuming extract DLQ");
}

export async function shutdownExtractQueue(): Promise<void> {
  const ch = channel;
  const conn = connection;
  channel = null;
  connection = null;
  rejectPendingPublishes(new Error("Extract queue shutting down"));
  try {
    await ch?.close();
  } finally {
    await conn?.close();
  }
}
