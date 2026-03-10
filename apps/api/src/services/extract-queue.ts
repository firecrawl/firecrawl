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
  subId?: string | null;
  apiKeyId?: number | null;
  agent?: any;
  createdAt: number;
};

let connection: amqp.ChannelModel | null = null;
let channel: amqp.Channel | null = null;

async function getChannel(): Promise<amqp.Channel> {
  if (channel) return channel;

  const url = config.NUQ_RABBITMQ_URL;
  if (!url) {
    throw new Error("NUQ_RABBITMQ_URL is not configured");
  }

  connection = await amqp.connect(url);
  channel = await connection.createChannel();

  // Set up the dead letter exchange
  await channel.assertExchange(EXTRACT_DLX, "direct", { durable: true });

  // Set up the dead letter queue
  await channel.assertQueue(EXTRACT_DLQ, {
    durable: true,
    arguments: {
      "x-queue-type": "quorum",
    },
  });
  await channel.bindQueue(EXTRACT_DLQ, EXTRACT_DLX, EXTRACT_QUEUE);

  // Set up the main queue with DLX - no retries (messages go straight to DLQ on reject/crash)
  await channel.assertQueue(EXTRACT_QUEUE, {
    durable: true,
    arguments: {
      "x-queue-type": "quorum",
      "x-dead-letter-exchange": EXTRACT_DLX,
      "x-dead-letter-routing-key": EXTRACT_QUEUE,
      "x-delivery-limit": 1,
    },
  });

  connection.on("close", () => {
    _logger.warn("Extract queue connection closed");
    connection = null;
    channel = null;
  });

  connection.on("error", err => {
    _logger.error("Extract queue connection error", { error: err });
  });

  return channel;
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
