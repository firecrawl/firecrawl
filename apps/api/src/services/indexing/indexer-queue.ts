import amqp from "amqplib";
import { config } from "../../config";
import { logger as _logger } from "../../lib/logger";

const logger = _logger.child({ module: "indexer-queue" });

const INDEX_EXCHANGE = "index.jobs";
const LINKS_QUEUE_NAME = "index.jobs.links";
const LINKS_RK = "job.links";

const CONNECT_TIMEOUT = 5000;
const DRAIN_TIMEOUT = 30000;
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;

type IndexWorkerMessage = {
  id: string;
  type: "links";
  discovery_url: string;
  urls: string[];
};

class IndexerQueue {
  private connection: amqp.ChannelModel | null = null;
  private publishChannel: amqp.Channel | null = null;

  private connectPromise: Promise<void> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelayMs = RECONNECT_BASE_DELAY_MS;

  private closing: boolean = false;
  private noop: boolean | null = null;

  async connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    if (this.closing) return;
    if (this.noop) return;
    if (this.connection && this.publishChannel) return;

    this.connectPromise = this._establishConnection();

    try {
      await this.connectPromise;
      if (this.closing) {
        await this.publishChannel?.close().catch(() => {});
        await this.connection?.close().catch(() => {});
        this.cleanup();
        return;
      }
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.reconnectDelayMs = RECONNECT_BASE_DELAY_MS;
    } finally {
      this.connectPromise = null;
    }
  }

  private async _establishConnection(): Promise<void> {
    if (!config.INDEXER_RABBITMQ_URL) {
      logger.debug("Indexer disabled via config");
      this.noop = true;
      return;
    }

    let connection: amqp.ChannelModel | null = this.connection;
    let channel: amqp.Channel | null = null;

    try {
      logger.info("Connecting to index RabbitMQ");

      if (!connection) {
        connection = await amqp.connect(config.INDEXER_RABBITMQ_URL);
      }
      channel = await connection.createChannel();

      // NOTE: this queue is already created by another service
      await channel.checkQueue(LINKS_QUEUE_NAME);

      if (this.closing) {
        await channel.close().catch(() => {});
        await connection.close().catch(() => {});
        return;
      }

      this.connection = connection;
      this.publishChannel = channel;

      this._registerConnectionEvents();

      logger.info("Connected to index RabbitMQ");
    } catch (err) {
      if (channel) {
        await channel.close().catch(() => {});
      }
      if (connection) {
        await connection.close().catch(() => {});
      }
      this.connection = null;
      this.publishChannel = null;
      throw err;
    }
  }

  private _registerConnectionEvents() {
    if (this.noop) return;
    if (!this.connection || !this.publishChannel) return;

    this.connection.on("close", () => {
      if (this.closing) return;

      logger.warn("Index RabbitMQ connection closed", {
        module: "index-queue",
      });

      this.cleanup();
      this.scheduleReconnect();
    });

    this.connection.on("error", err => {
      logger.error("Index RabbitMQ connection error", {
        err,
      });
    });

    this.publishChannel.on("close", () => {
      logger.warn("Index RabbitMQ channel closed", {
        module: "index-queue",
      });
      this.publishChannel = null;
      if (!this.closing) {
        this.scheduleReconnect();
      }
    });

    this.publishChannel.on("error", err => {
      logger.error("Index RabbitMQ channel error", {
        err,
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closing || this.noop) return;

    const delayMs = this.reconnectDelayMs;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.closing || this.noop || (this.connection && this.publishChannel))
        return;

      try {
        await this.connect();
        this.reconnectDelayMs = RECONNECT_BASE_DELAY_MS;
        logger.info("Index RabbitMQ reconnected successfully");
      } catch (err) {
        logger.error("Index RabbitMQ reconnection failed", {
          err,
          delayMs,
        });
        this.reconnectDelayMs = Math.min(delayMs * 2, RECONNECT_MAX_DELAY_MS);
        this.scheduleReconnect();
      }
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  async sendToWorker(message: IndexWorkerMessage): Promise<void> {
    await this.connect();

    if (this.noop) return;
    if (!this.publishChannel) throw new Error("Channel not available");

    const payload = {
      id: message.id,
    } as any;

    if (message.type === "links") {
      payload.urls = message.urls;
      payload.discovery_url = message.discovery_url;
    }

    const buffer = Buffer.from(JSON.stringify(payload));

    const canSendMore = this.publishChannel.publish(
      INDEX_EXCHANGE,
      LINKS_RK,
      buffer,
      {
        persistent: true,
        contentType: "application/json",
        messageId: message.id,
      },
    );

    if (!canSendMore) {
      logger.warn("Index message buffer full, waiting for drain");
      await this.waitForDrain();
    }
  }

  private async waitForDrain(): Promise<void> {
    if (this.noop) return;

    return new Promise((resolve, reject) => {
      if (!this.publishChannel) {
        return reject(new Error("Channel not available"));
      }

      const listeners: Record<string, any> = {};

      const cleanup = () => {
        if (!this.publishChannel) return;
        this.publishChannel.removeListener("drain", listeners.drain);
        this.publishChannel.removeListener("error", listeners.error);
        this.publishChannel.removeListener("close", listeners.close);
        clearTimeout(listeners.timeout);
      };

      listeners.drain = () => {
        cleanup();
        resolve();
      };
      listeners.error = (err: Error) => {
        cleanup();
        reject(err);
      };
      listeners.close = () => {
        cleanup();
        reject(new Error("Channel closed during drain"));
      };

      listeners.timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Drain timeout after ${DRAIN_TIMEOUT}ms`));
      }, DRAIN_TIMEOUT);

      this.publishChannel.on("drain", listeners.drain);
      this.publishChannel.on("error", listeners.error);
      this.publishChannel.on("close", listeners.close);
    });
  }

  async close(): Promise<void> {
    if (this.noop) return;
    this.closing = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.connectPromise) {
      try {
        await this.connectPromise;
      } catch {}
    }

    try {
      await this.publishChannel?.close();
      await this.connection?.close();
    } catch (err) {
      logger.warn("Error while closing RabbitMQ connection", { err });
    } finally {
      this.cleanup();
      logger.info("Indexer RabbitMQ closed");
    }
  }

  private cleanup() {
    this.connection = null;
    this.publishChannel = null;
    this.connectPromise = null;
  }
}

export const indexerQueue = new IndexerQueue();

export async function shutdownIndexerQueue(): Promise<void> {
  await indexerQueue.close();
}
