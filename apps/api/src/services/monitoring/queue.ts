import amqp from "amqplib";
import { config } from "../../config";
import { logger as _logger } from "../../lib/logger";

const MONITOR_CHECK_QUEUE = "monitor.checks";
const MONITOR_CHECK_DLX = "monitor.checks.dlx";
const MONITOR_CHECK_DLQ = "monitor.checks.dlq";

const logger = _logger.child({ module: "monitoring-queue" });

export type MonitorCheckJobData = {
  monitorId: string;
  checkId: string;
  teamId: string;
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

  await channel.assertExchange(MONITOR_CHECK_DLX, "direct", { durable: true });
  await channel.assertQueue(MONITOR_CHECK_DLQ, {
    durable: true,
    arguments: {
      "x-queue-type": "quorum",
    },
  });
  await channel.bindQueue(
    MONITOR_CHECK_DLQ,
    MONITOR_CHECK_DLX,
    MONITOR_CHECK_QUEUE,
  );

  await channel.assertQueue(MONITOR_CHECK_QUEUE, {
    durable: true,
    arguments: {
      "x-queue-type": "quorum",
      "x-dead-letter-exchange": MONITOR_CHECK_DLX,
      "x-dead-letter-routing-key": MONITOR_CHECK_QUEUE,
      "x-delivery-limit": 1,
    },
  });

  connection.on("close", () => {
    logger.warn("Monitor queue connection closed");
    connection = null;
    channel = null;
  });

  connection.on("error", error => {
    logger.error("Monitor queue connection error", { error });
  });

  return channel;
}

export async function addMonitorCheckJob(
  data: MonitorCheckJobData,
): Promise<void> {
  const ch = await getChannel();
  const sent = ch.sendToQueue(
    MONITOR_CHECK_QUEUE,
    Buffer.from(JSON.stringify(data)),
    {
      persistent: true,
      contentType: "application/json",
      messageId: data.checkId,
    },
  );

  if (!sent) {
    logger.warn("Monitor check message buffer full", {
      monitorId: data.monitorId,
      checkId: data.checkId,
    });
  }

  logger.info("Monitor check job added to queue", {
    monitorId: data.monitorId,
    checkId: data.checkId,
    teamId: data.teamId,
  });
}

export async function consumeMonitorCheckJobs(
  handler: (data: MonitorCheckJobData) => Promise<void>,
): Promise<void> {
  const ch = await getChannel();
  await ch.prefetch(1);

  await ch.consume(
    MONITOR_CHECK_QUEUE,
    async msg => {
      if (!msg) return;

      let data: MonitorCheckJobData;
      try {
        data = JSON.parse(msg.content.toString()) as MonitorCheckJobData;
      } catch (error) {
        logger.error("Failed to parse monitor check job", { error });
        ch.nack(msg, false, false);
        return;
      }

      const jobLogger = logger.child({
        monitorId: data.monitorId,
        checkId: data.checkId,
        teamId: data.teamId,
      });

      try {
        await handler(data);
        ch.ack(msg);
      } catch (error) {
        jobLogger.error("Monitor check job failed", { error });
        ch.nack(msg, false, false);
      }
    },
    { noAck: false },
  );

  logger.info("Started consuming monitor check jobs");
}
