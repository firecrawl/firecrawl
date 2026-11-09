import amqp from "amqplib";
import { config } from "../config";
import { logger as _logger } from "../lib/logger";

const EXTRACT_QUEUE = "extract.jobs";
const EXTRACT_DLX = "extract.dlx";
const EXTRACT_DLQ = "extract.dlq";

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
let channel: amqp.Channel | null = null;
let channelPromise: Promise<amqp.Channel> | null = null;

function getChannel(): Promise<amqp.Channel> {
  channelPromise ??= openChannel().catch(err => {
    channelPromise = null;
    throw err;
  });
  return channelPromise;
}

async function openChannel(): Promise<amqp.Channel> {
  const url = config.NUQ_RABBITMQ_URL;
  if (!url) {
    throw new Error("NUQ_RABBITMQ_URL is not configured");
  }

  if (!connection) {
    const conn = await amqp.connect(url);
    conn.on("error", err => {
      _logger.error("Extract queue connection error", { error: err });
    });
    conn.on("close", () => {
      _logger.warn("Extract queue connection closed");
      if (connection !== conn) return;
      connection = null;
      channel = null;
      channelPromise = null;
    });
    connection = conn;
  }

  const ch = await connection.createChannel();
  ch.on("error", err => {
    _logger.error("Extract queue channel error", { error: err });
  });
  ch.on("close", () => {
    if (channel !== ch) return;
    channel = null;
    channelPromise = null;
  });
  channel = ch;

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

  return ch;
}

export async function addExtractJob(
  extractId: string,
  data: ExtractJobData,
): Promise<void> {
  const ch = await getChannel();
  ch.sendToQueue(EXTRACT_QUEUE, Buffer.from(JSON.stringify(data)), {
    persistent: true,
    messageId: extractId,
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
  if (channel) {
    await channel.close();
    channel = null;
  }
  if (connection) {
    await connection.close();
    connection = null;
  }
}
