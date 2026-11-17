import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

const { connectMock, channelMock, connectionMock } = vi.hoisted(() => {
  const channelMock = {
    checkQueue: vi
      .fn()
      .mockResolvedValue({
        queue: "webhooks",
        messageCount: 0,
        consumerCount: 0,
      }),
    sendToQueue: vi.fn(() => true),
    close: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
    removeListener: vi.fn(),
  };
  const connectionMock = {
    createChannel: vi.fn().mockResolvedValue(channelMock),
    on: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    removeAllListeners: vi.fn(),
  };
  const connectMock = vi.fn().mockResolvedValue(connectionMock);
  return { connectMock, channelMock, connectionMock };
});

vi.mock("amqplib", () => ({ default: { connect: connectMock } }));
vi.mock("../../config", () => ({
  config: { NUQ_RABBITMQ_URL: "amqp://test" },
}));
vi.mock("../../lib/logger", () => {
  const mk = (): Record<string, unknown> => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => mk(),
  });
  return { logger: mk() };
});

function getConnectionCloseHandler(): () => void {
  const call = (connectionMock.on as Mock).mock.calls.find(
    c => c[0] === "close",
  );
  return call?.[1] as () => void;
}

function getChannelCloseHandler(): () => void {
  const call = (channelMock.on as Mock).mock.calls.find(
    c => c[0] === "close",
  );
  return call?.[1] as () => void;
}

async function freshWebhookQueueModule() {
  vi.resetModules();
  return import("./queue.js");
}

describe("WebhookQueue RabbitMQ reconnect resilience", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue(connectionMock);
    connectionMock.createChannel.mockResolvedValue(channelMock);
    channelMock.checkQueue.mockResolvedValue({
      queue: "webhooks",
      messageCount: 0,
      consumerCount: 0,
    });
    channelMock.sendToQueue.mockReturnValue(true);
  });

  it("connects and publishes message successfully", async () => {
    const { webhookQueue } = await freshWebhookQueueModule();
    await webhookQueue.publish({
      webhookId: "wh_1",
      url: "https://example.com/webhook",
      event: "test",
      data: { hello: "world" },
    } as any);

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(channelMock.sendToQueue).toHaveBeenCalledTimes(1);
    await webhookQueue.close();
  });

  it("reconnects with exponential backoff after connection close", async () => {
    vi.useFakeTimers();
    try {
      const { webhookQueue } = await freshWebhookQueueModule();
      await webhookQueue.connect();
      expect(connectMock).toHaveBeenCalledTimes(1);

      const onClose = getConnectionCloseHandler();
      expect(onClose).toBeTypeOf("function");

      // First reconnect attempt fails (broker is still restarting)
      connectMock.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
      onClose();

      // Base delay is 1000ms
      await vi.advanceTimersByTimeAsync(1000);
      expect(connectMock).toHaveBeenCalledTimes(2);

      // Second attempt succeeds after backoff (2000ms)
      connectMock.mockResolvedValueOnce(connectionMock);
      await vi.advanceTimersByTimeAsync(1999);
      expect(connectMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(connectMock).toHaveBeenCalledTimes(3);

      expect(channelMock.checkQueue).toHaveBeenCalled();
      await webhookQueue.publish({
        webhookId: "wh_2",
        url: "https://example.com/webhook2",
        event: "test2",
        data: { hello: "world2" },
      } as any);
      expect(channelMock.sendToQueue).toHaveBeenCalled();

      await webhookQueue.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconnects when channel closes independently", async () => {
    vi.useFakeTimers();
    try {
      const { webhookQueue } = await freshWebhookQueueModule();
      await webhookQueue.connect();
      expect(connectionMock.createChannel).toHaveBeenCalledTimes(1);

      const onChannelClose = getChannelCloseHandler();
      expect(onChannelClose).toBeTypeOf("function");

      onChannelClose();

      await vi.advanceTimersByTimeAsync(1000);
      expect(connectionMock.createChannel).toHaveBeenCalledTimes(2);

      await webhookQueue.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops reconnect timer when closed", async () => {
    vi.useFakeTimers();
    try {
      const { webhookQueue } = await freshWebhookQueueModule();
      await webhookQueue.connect();
      const onClose = getConnectionCloseHandler();

      connectMock.mockRejectedValue(new Error("broker down"));
      onClose();

      await vi.advanceTimersByTimeAsync(1000);
      expect(connectMock).toHaveBeenCalledTimes(2);

      // Now close
      await webhookQueue.close();
      await vi.advanceTimersByTimeAsync(10000);

      // No more reconnect calls should happen after close
      expect(connectMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not accumulate connection listeners on channel-only reconnect", async () => {
    vi.useFakeTimers();
    try {
      const { webhookQueue } = await freshWebhookQueueModule();
      await webhookQueue.connect();

      const initialConnectionOnCalls = (connectionMock.on as Mock).mock.calls.length;

      const onChannelClose = getChannelCloseHandler();
      expect(onChannelClose).toBeTypeOf("function");

      onChannelClose();
      await vi.advanceTimersByTimeAsync(1000);

      expect(connectionMock.createChannel).toHaveBeenCalledTimes(2);
      expect((connectionMock.on as Mock).mock.calls.length).toBe(initialConnectionOnCalls);

      await webhookQueue.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds close wait on in-flight connectPromise to prevent hanging shutdown", async () => {
    vi.useFakeTimers();
    try {
      const { webhookQueue } = await freshWebhookQueueModule();

      // Hanging connect
      connectMock.mockReturnValueOnce(new Promise(() => {}));

      const connectPromise = webhookQueue.connect();
      const closePromise = webhookQueue.close();

      // Advance past CONNECT_TIMEOUT (5000ms)
      await vi.advanceTimersByTimeAsync(5000);

      await expect(closePromise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
