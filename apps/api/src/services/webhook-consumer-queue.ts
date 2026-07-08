import amqp from "amqplib";
import { config } from "../config";
import { logger as _logger } from "../lib/logger";
import type { WebhookQueueMessage } from "./webhook/types";

// Must match the queue name in queue.ts (publisher)
const WEBHOOK_QUEUE = "webhooks";
const WEBHOOK_DLX = "webhooks.dlx";
const WEBHOOK_DLQ = "webhooks.dlq";

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
  await channel.assertExchange(WEBHOOK_DLX, "direct", { durable: true });

  // Set up the dead letter queue (quorum queue for durability)
  await channel.assertQueue(WEBHOOK_DLQ, {
    durable: true,
    arguments: {
      "x-queue-type": "quorum",
    },
  });
  await channel.bindQueue(WEBHOOK_DLQ, WEBHOOK_DLX, WEBHOOK_QUEUE);

  // The "webhooks" queue already exists (created by the Rust dispatcher or
  // previous infrastructure). Use checkQueue to verify it exists without
  // changing its arguments. If it doesn't exist yet, fall back to assertQueue.
  try {
    await channel.checkQueue(WEBHOOK_QUEUE);
  } catch {
    // Queue doesn't exist - create it. Need to re-establish the channel
    // since checkQueue failure closes it.
    channel = await connection.createChannel();
    await channel.assertQueue(WEBHOOK_QUEUE, {
      durable: true,
      arguments: {
        "x-queue-type": "quorum",
        "x-dead-letter-exchange": WEBHOOK_DLX,
        "x-dead-letter-routing-key": WEBHOOK_QUEUE,
      },
    });
  }

  connection.on("close", () => {
    _logger.warn("Webhook consumer connection closed");
    connection = null;
    channel = null;
  });

  connection.on("error", err => {
    _logger.error("Webhook consumer connection error", { error: err });
  });

  return channel;
}

export async function consumeWebhookJobs(
  handler: (
    data: WebhookQueueMessage,
    ack: () => void,
    nack: () => void,
  ) => Promise<void>,
): Promise<void> {
  const ch = await getChannel();
  const prefetch = config.WEBHOOK_WORKER_PREFETCH_COUNT;
  await ch.prefetch(prefetch);

  await ch.consume(
    WEBHOOK_QUEUE,
    async msg => {
      if (!msg) return;

      let data: WebhookQueueMessage;
      try {
        data = JSON.parse(msg.content.toString()) as WebhookQueueMessage;
      } catch (error) {
        _logger.error("Failed to parse webhook queue message", { error });
        ch.ack(msg); // Discard malformed messages
        return;
      }

      const logger = _logger.child({
        module: "webhook-consumer",
        jobId: data.job_id,
        teamId: data.team_id,
        event: data.event,
      });

      logger.info("Processing webhook delivery");

      try {
        await handler(
          data,
          () => ch.ack(msg),
          () => ch.nack(msg, false, false), // Don't requeue - send to DLX
        );
      } catch (error) {
        logger.error("Webhook handler threw an unhandled error", { error });
        ch.nack(msg, false, false);
      }
    },
    { noAck: false },
  );

  _logger.info("Started consuming webhook jobs", { prefetch });
}

export async function consumeWebhookDLQ(
  handler: (data: WebhookQueueMessage) => Promise<void>,
): Promise<void> {
  const ch = await getChannel();
  await ch.prefetch(1);

  await ch.consume(
    WEBHOOK_DLQ,
    async msg => {
      if (!msg) return;

      let data: WebhookQueueMessage;
      try {
        data = JSON.parse(msg.content.toString()) as WebhookQueueMessage;
      } catch (error) {
        _logger.error("Failed to parse webhook DLQ message", { error });
        ch.ack(msg);
        return;
      }

      const logger = _logger.child({
        module: "webhook-dlq",
        jobId: data.job_id,
        teamId: data.team_id,
      });

      logger.info("Processing dead-lettered webhook");

      try {
        await handler(data);
        ch.ack(msg);
      } catch (error) {
        logger.error("DLQ handler threw an error, requeueing", { error });
        ch.nack(msg, false, true); // Requeue DLQ messages so we don't lose them
      }
    },
    { noAck: false },
  );

  _logger.info("Started consuming webhook DLQ");
}

export async function shutdownWebhookConsumerQueue(): Promise<void> {
  if (channel) {
    await channel.close();
    channel = null;
  }
  if (connection) {
    await connection.close();
    connection = null;
  }
}
