import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

const { connectMock, channelMock, connectionMock } = vi.hoisted(() => {
  const channelMock = {
    checkQueue: vi
      .fn()
      .mockResolvedValue({
        queue: "index.jobs.links",
        messageCount: 0,
        consumerCount: 0,
      }),
    publish: vi.fn(() => true),
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
  config: { INDEXER_RABBITMQ_URL: "amqp://test" },
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

async function freshIndexerQueueModule() {
  vi.resetModules();
  return import("./indexer-queue.js");
}

describe("IndexerQueue RabbitMQ reconnect resilience", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue(connectionMock);
    connectionMock.createChannel.mockResolvedValue(channelMock);
    channelMock.checkQueue.mockResolvedValue({
      queue: "index.jobs.links",
      messageCount: 0,
      consumerCount: 0,
    });
    channelMock.publish.mockReturnValue(true);
  });

  it("connects and sends message to worker successfully", async () => {
    const { indexerQueue } = await freshIndexerQueueModule();
    await indexerQueue.sendToWorker({
      id: "idx_1",
      type: "links",
      discovery_url: "https://example.com",
      urls: ["https://example.com/a", "https://example.com/b"],
    });

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(channelMock.publish).toHaveBeenCalledTimes(1);
    await indexerQueue.close();
  });

  it("reconnects with exponential backoff after connection close", async () => {
    vi.useFakeTimers();
    try {
      const { indexerQueue } = await freshIndexerQueueModule();
      await indexerQueue.connect();
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
      await indexerQueue.sendToWorker({
        id: "idx_2",
        type: "links",
        discovery_url: "https://example.com/2",
        urls: ["https://example.com/c"],
      });
      expect(channelMock.publish).toHaveBeenCalled();

      await indexerQueue.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconnects when publish channel closes independently", async () => {
    vi.useFakeTimers();
    try {
      const { indexerQueue } = await freshIndexerQueueModule();
      await indexerQueue.connect();
      expect(connectionMock.createChannel).toHaveBeenCalledTimes(1);

      const onChannelClose = getChannelCloseHandler();
      expect(onChannelClose).toBeTypeOf("function");

      onChannelClose();

      await vi.advanceTimersByTimeAsync(1000);
      expect(connectionMock.createChannel).toHaveBeenCalledTimes(2);

      await indexerQueue.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops reconnect timer when closed", async () => {
    vi.useFakeTimers();
    try {
      const { indexerQueue } = await freshIndexerQueueModule();
      await indexerQueue.connect();
      const onClose = getConnectionCloseHandler();

      connectMock.mockRejectedValue(new Error("broker down"));
      onClose();

      await vi.advanceTimersByTimeAsync(1000);
      expect(connectMock).toHaveBeenCalledTimes(2);

      // Now close
      await indexerQueue.close();
      await vi.advanceTimersByTimeAsync(10000);

      // No more reconnect calls should happen after close
      expect(connectMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
