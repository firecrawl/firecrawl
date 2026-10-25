import amqp from "amqplib";
import { AmqpConnection } from "../lib/amqp-connection";
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

async function setupChannel(channel: amqp.Channel): Promise<void> {
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
}

const publisher = new AmqpConnection(
  () => config.NUQ_RABBITMQ_URL,
  "Extract publisher",
  setupChannel,
);
let jobsConsumer: AmqpConnection | null = null;
let dlqConsumer: AmqpConnection | null = null;

export async function addExtractJob(
  extractId: string,
  data: ExtractJobData,
): Promise<void> {
  const { channel: ch } = await publisher.connect();
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
  if (jobsConsumer) {
    await jobsConsumer.connect();
    return;
  }
  jobsConsumer = new AmqpConnection(
    () => config.NUQ_RABBITMQ_URL,
    "Extract consumer",
    async (ch, invalidate) => {
      await setupChannel(ch);
      await ch.prefetch(1);

      await ch.consume(
        EXTRACT_QUEUE,
        async msg => {
          if (!msg) {
            invalidate();
            return;
          }

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
    },
  );
  await jobsConsumer.connect();
}

export async function consumeExtractDLQ(
  handler: (data: ExtractJobData) => Promise<void>,
): Promise<void> {
  if (dlqConsumer) {
    await dlqConsumer.connect();
    return;
  }
  dlqConsumer = new AmqpConnection(
    () => config.NUQ_RABBITMQ_URL,
    "Extract DLQ consumer",
    async (ch, invalidate) => {
      await setupChannel(ch);
      await ch.prefetch(1);

      await ch.consume(
        EXTRACT_DLQ,
        async msg => {
          if (!msg) {
            invalidate();
            return;
          }

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
    },
  );
  await dlqConsumer.connect();
}

export async function shutdownExtractQueue(): Promise<void> {
  await Promise.all([
    publisher.close(),
    jobsConsumer?.close(),
    dlqConsumer?.close(),
  ]);
}
