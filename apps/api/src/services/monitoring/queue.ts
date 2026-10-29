import amqp from "amqplib";
import { config } from "../../config";
import { logger as _logger } from "../../lib/logger";

const MONITOR_CHECK_QUEUE = "monitor.checks";
const MONITOR_CHECK_DLX = "monitor.checks.dlx";
const MONITOR_CHECK_DLQ = "monitor.checks.dlq";

// Dedicated queue so a burst of heavy search checks can't starve page/site/batch checks.
const MONITOR_SEARCH_CHECK_QUEUE = "monitor.checks.search";
const MONITOR_SEARCH_CHECK_DLX = "monitor.checks.search.dlx";
const MONITOR_SEARCH_CHECK_DLQ = "monitor.checks.search.dlq";

const logger = _logger.child({ module: "monitoring-queue" });

export type MonitorCheckJobData = {
  monitorId: string;
  checkId: string;
  teamId: string;
};

type ConsumerHandler = (data: MonitorCheckJobData) => Promise<void>;

let connection: amqp.ChannelModel | null = null;
// Memoized so concurrent callers share one connect() instead of racing to open
// (and orphan) duplicate connections.
let connectionPromise: Promise<amqp.ChannelModel> | null = null;
// Separate publish/consume channels so an exception on one can't tear down the other.
let publishChannel: amqp.Channel | null = null;
let consumeChannel: amqp.Channel | null = null;
// Memoized creation promises serialize concurrent callers onto one channel; without
// this, two callers racing during the async asserts would each create one and orphan one.
let publishChannelPromise: Promise<amqp.Channel> | null = null;
let consumeChannelPromise: Promise<amqp.Channel> | null = null;

// Registry of consumers so a reconnect can re-attach them; the worker never produces,
// so without this it goes permanently deaf after any RabbitMQ blip until restart.
const registeredConsumers: Array<{
  queue: string;
  handler: ConsumerHandler;
  prefetch: number;
}> = [];
// Search checks run inline (search + judge + scrapes) for 15-50s each, so a single
// prefetch serializes them and a burst piles up behind one check. Let a worker run a
// few concurrently; each still fans out SEARCH_SCRAPE_CONCURRENCY scrapes, so keep it
// modest. Default (page/site/batch) checks just enqueue async jobs, so 1 is fine.
const SEARCH_CHECK_PREFETCH = 3;
// Queues with a live consumer on the CURRENT consume channel; cleared on drop so a
// reconnect re-subscribes exactly once per queue and can't pile up duplicates.
const subscribedQueues = new Set<string>();
let reconnectInFlight = false;
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;

// Declare a check queue plus its dead-letter exchange/queue.
async function assertCheckQueue(
  ch: amqp.Channel,
  queue: string,
  dlx: string,
  dlq: string,
): Promise<void> {
  await ch.assertExchange(dlx, "direct", { durable: true });
  await ch.assertQueue(dlq, {
    durable: true,
    arguments: {
      "x-queue-type": "quorum",
    },
  });
  await ch.bindQueue(dlq, dlx, queue);
  await ch.assertQueue(queue, {
    durable: true,
    arguments: {
      "x-queue-type": "quorum",
      "x-dead-letter-exchange": dlx,
      "x-dead-letter-routing-key": queue,
      "x-delivery-limit": 1,
    },
  });
}

async function assertTopology(ch: amqp.Channel): Promise<void> {
  await assertCheckQueue(
    ch,
    MONITOR_CHECK_QUEUE,
    MONITOR_CHECK_DLX,
    MONITOR_CHECK_DLQ,
  );
  await assertCheckQueue(
    ch,
    MONITOR_SEARCH_CHECK_QUEUE,
    MONITOR_SEARCH_CHECK_DLX,
    MONITOR_SEARCH_CHECK_DLQ,
  );
}

// Drop cached state and, if any consumers are registered, kick off a backoff reconnect.
function handleConnectionDrop(reason: string, error?: unknown): void {
  if (connection || publishChannel || consumeChannel) {
    logger.warn("Monitor queue dropped — will reconnect", { reason, error });
  }
  connection = null;
  connectionPromise = null;
  publishChannel = null;
  publishChannelPromise = null;
  consumeChannel = null;
  consumeChannelPromise = null;
  subscribedQueues.clear();
  if (registeredConsumers.length > 0) {
    scheduleReconnect(RECONNECT_BASE_DELAY_MS);
  }
}

function scheduleReconnect(delayMs: number): void {
  if (reconnectInFlight) return;
  reconnectInFlight = true;

  setTimeout(async () => {
    try {
      const ch = await getConsumeChannel();
      for (const { queue, handler, prefetch } of registeredConsumers) {
        await subscribe(ch, queue, handler, prefetch);
      }
      reconnectInFlight = false;
      logger.info("Monitor queue reconnected; consumers re-subscribed", {
        consumers: registeredConsumers.length,
      });
    } catch (error) {
      reconnectInFlight = false;
      const nextDelay = Math.min(delayMs * 2, RECONNECT_MAX_DELAY_MS);
      logger.error("Monitor queue reconnect failed; retrying", {
        error,
        nextDelayMs: nextDelay,
      });
      // Reset ALL cached state including subscribedQueues: a mid-loop subscribe()
      // failure on a healthy channel never fires "close", so a stale entry would
      // make the next reconnect skip (subscribe early-returns) and deafen that queue.
      await consumeChannel?.close().catch(() => {});
      connection = null;
      connectionPromise = null;
      publishChannel = null;
      publishChannelPromise = null;
      consumeChannel = null;
      consumeChannelPromise = null;
      subscribedQueues.clear();
      scheduleReconnect(nextDelay);
    }
  }, delayMs);
}

async function getConnection(): Promise<amqp.ChannelModel> {
  if (connection) return connection;
  if (!connectionPromise) {
    connectionPromise = openConnection()
      .then(conn => {
        connection = conn;
        return conn;
      })
      .catch(err => {
        connectionPromise = null;
        throw err;
      });
  }
  return connectionPromise;
}

async function openConnection(): Promise<amqp.ChannelModel> {
  const url = config.NUQ_RABBITMQ_URL;
  if (!url) {
    throw new Error("NUQ_RABBITMQ_URL is not configured");
  }

  // Name the connection so operators can identify monitoring traffic in the management UI.
  const conn = await amqp.connect(url, {
    clientProperties: { connection_name: "monitoring-queue" },
  });
  conn.on("close", () => handleConnectionDrop("connection closed"));
  conn.on("error", error =>
    logger.error("Monitor queue connection error", { error }),
  );
  return conn;
}

async function createChannel(label: string): Promise<amqp.Channel> {
  const conn = await getConnection();
  const ch = await conn.createChannel();
  await assertTopology(ch);
  // Channels can close independently of the connection (e.g. PRECONDITION_FAILED);
  // without this the cached channel stays non-null and every send/consume throws forever.
  ch.on("close", () => {
    if (label === "publish" && publishChannel === ch) {
      publishChannel = null;
      publishChannelPromise = null;
    }
    if (label === "consume" && consumeChannel === ch) {
      consumeChannel = null;
      consumeChannelPromise = null;
      handleConnectionDrop("consume channel closed");
    }
  });
  ch.on("error", error =>
    logger.error("Monitor queue channel error", { label, error }),
  );
  return ch;
}

async function getPublishChannel(): Promise<amqp.Channel> {
  if (publishChannel) return publishChannel;
  if (!publishChannelPromise) {
    publishChannelPromise = createChannel("publish")
      .then(ch => {
        publishChannel = ch;
        return ch;
      })
      .catch(err => {
        publishChannelPromise = null;
        throw err;
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
      .catch(err => {
        consumeChannelPromise = null;
        throw err;
      });
  }
  return consumeChannelPromise;
}

export async function addMonitorCheckJob(
  data: MonitorCheckJobData,
  opts: { search?: boolean } = {},
): Promise<void> {
  const ch = await getPublishChannel();
  const queue = opts.search ? MONITOR_SEARCH_CHECK_QUEUE : MONITOR_CHECK_QUEUE;
  const sent = ch.sendToQueue(queue, Buffer.from(JSON.stringify(data)), {
    persistent: true,
    contentType: "application/json",
    messageId: data.checkId,
  });

  if (!sent) {
    logger.warn("Monitor check message buffer full", {
      monitorId: data.monitorId,
      checkId: data.checkId,
      queue,
    });
  }

  logger.info("Monitor check job added to queue", {
    monitorId: data.monitorId,
    checkId: data.checkId,
    teamId: data.teamId,
    queue,
  });
}

async function consumeQueue(
  queue: string,
  handler: ConsumerHandler,
  prefetch: number,
): Promise<void> {
  if (!registeredConsumers.some(c => c.queue === queue)) {
    registeredConsumers.push({ queue, handler, prefetch });
  }
  const ch = await getConsumeChannel();
  await subscribe(ch, queue, handler, prefetch);
}

async function subscribe(
  ch: amqp.Channel,
  queue: string,
  handler: ConsumerHandler,
  prefetch: number,
): Promise<void> {
  // Don't add a duplicate consumer if a reconnect re-subscribes an already-subscribed queue.
  if (subscribedQueues.has(queue)) return;
  // Per-consumer prefetch (global=false) so the search and default consumers each get
  // their own in-flight budget and don't block each other.
  await ch.prefetch(prefetch, false);

  await ch.consume(
    queue,
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

  subscribedQueues.add(queue);
  logger.info("Started consuming monitor check jobs", { queue });
}

export async function consumeMonitorCheckJobs(
  handler: (data: MonitorCheckJobData) => Promise<void>,
): Promise<void> {
  await consumeQueue(MONITOR_CHECK_QUEUE, handler, 1);
}

export async function consumeMonitorSearchCheckJobs(
  handler: (data: MonitorCheckJobData) => Promise<void>,
): Promise<void> {
  await consumeQueue(
    MONITOR_SEARCH_CHECK_QUEUE,
    handler,
    SEARCH_CHECK_PREFETCH,
  );
}
