import amqp from "amqplib";
import { config } from "../../config";
import { logger as _logger } from "../../lib/logger";
import { WebhookQueueMessage } from "./types";

const WEBHOOK_QUEUE_NAME = "webhooks";
const CONNECT_TIMEOUT = 5000;
const DRAIN_TIMEOUT = 30000;
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;

class WebhookQueue {
  private connection: amqp.ChannelModel | null = null;
  private channel: amqp.Channel | null = null;

  private connectPromise: Promise<void> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelayMs = RECONNECT_BASE_DELAY_MS;
  private closing = false;

  async connect(): Promise<void> {
    if (this.connection && this.channel) return;
    if (this.closing) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this._establishConnection();

    try {
      await this.connectPromise;
      if (this.closing) {
        await this.channel?.close().catch(() => {});
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
    if (!config.NUQ_RABBITMQ_URL) {
      throw new Error("NUQ_RABBITMQ_URL is not configured");
    }

    const isNewConnection = !this.connection;
    let connection: amqp.ChannelModel | null = this.connection;
    let channel: amqp.Channel | null = null;

    try {
      _logger.info("Connecting to webhook RabbitMQ", {
        module: "webhook-queue",
      });

      if (!connection) {
        connection = await amqp.connect(config.NUQ_RABBITMQ_URL);
      }
      channel = await connection.createChannel();

      await channel.checkQueue(WEBHOOK_QUEUE_NAME);

      if (this.closing) {
        await channel.close().catch(() => {});
        await connection.close().catch(() => {});
        return;
      }

      this.connection = connection;
      this.channel = channel;

      if (isNewConnection) {
        this._registerConnectionEvents(connection);
      }
      this._registerChannelEvents(channel);

      _logger.info("Connected to webhook RabbitMQ", {
        module: "webhook-queue",
      });
    } catch (err) {
      if (channel) {
        await channel.close().catch(() => {});
      }
      if (connection) {
        await connection.close().catch(() => {});
      }
      this.connection = null;
      this.channel = null;
      throw err;
    }
  }

  private _registerConnectionEvents(connection: amqp.ChannelModel) {
    connection.on("close", () => {
      _logger.warn("Webhook RabbitMQ connection closed", {
        module: "webhook-queue",
      });
      this.cleanup();
      if (!this.closing) {
        this.scheduleReconnect();
      }
    });

    connection.on("error", err => {
      _logger.error("Webhook RabbitMQ connection error", {
        module: "webhook-queue",
        err,
      });
    });
  }

  private _registerChannelEvents(channel: amqp.Channel) {
    channel.on("close", () => {
      _logger.warn("Webhook RabbitMQ channel closed", {
        module: "webhook-queue",
      });
      this.channel = null;
      if (!this.closing) {
        this.scheduleReconnect();
      }
    });

    channel.on("error", err => {
      _logger.error("Webhook RabbitMQ channel error", {
        module: "webhook-queue",
        err,
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closing) return;

    const delayMs = this.reconnectDelayMs;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.closing || (this.connection && this.channel)) return;

      try {
        await this.connect();
        this.reconnectDelayMs = RECONNECT_BASE_DELAY_MS;
        _logger.info("Webhook RabbitMQ reconnected successfully", {
          module: "webhook-queue",
        });
      } catch (err) {
        _logger.error("Webhook RabbitMQ reconnection failed", {
          module: "webhook-queue",
          err,
          delayMs,
        });
        this.reconnectDelayMs = Math.min(delayMs * 2, RECONNECT_MAX_DELAY_MS);
        this.scheduleReconnect();
      }
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  async publish(message: WebhookQueueMessage): Promise<void> {
    await this.connect();

    if (!this.channel) throw new Error("Channel not available");

    const buffer = Buffer.from(JSON.stringify(message));

    const canSendMore = this.channel.sendToQueue(WEBHOOK_QUEUE_NAME, buffer, {
      persistent: true,
      contentType: "application/json",
    });

    if (!canSendMore) {
      _logger.warn("Webhook message buffer full, waiting for drain", {
        module: "webhook-queue",
        teamId: message.team_id,
      });

      await this.waitForDrain();
    }

    _logger.info("Webhook message published", {
      module: "webhook-queue",
      teamId: message.team_id,
      jobId: message.job_id,
      event: message.event,
    });
  }

  private async waitForDrain(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.channel) {
        return reject(new Error("Channel not available"));
      }

      const listeners: Record<string, any> = {};

      const cleanup = () => {
        if (!this.channel) return;
        this.channel.removeListener("drain", listeners.drain);
        this.channel.removeListener("error", listeners.error);
        this.channel.removeListener("close", listeners.close);
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

      this.channel.on("drain", listeners.drain);
      this.channel.on("error", listeners.error);
      this.channel.on("close", listeners.close);
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.connectPromise) {
      try {
        await Promise.race([
          this.connectPromise,
          new Promise(resolve => setTimeout(resolve, CONNECT_TIMEOUT)),
        ]);
      } catch {}
    }
    try {
      await this.channel?.close();
      await this.connection?.close();
    } catch (err) {
      _logger.warn("Error while closing RabbitMQ connection", { err });
    } finally {
      this.cleanup();
      _logger.info("Webhook RabbitMQ closed", { module: "webhook-queue" });
    }
  }

  private cleanup() {
    this.connection = null;
    this.channel = null;
    this.connectPromise = null;
  }
}

export const webhookQueue = new WebhookQueue();

export async function shutdownWebhookQueue(): Promise<void> {
  await webhookQueue.close();
}
