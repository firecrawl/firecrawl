import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

const { connectMock, channelMock, connectionMock, pgPoolMock, pgClientMock } =
  vi.hoisted(() => {
    const channelMock = {
      assertQueue: vi
        .fn()
        .mockResolvedValue({ queue: "test_queue.listen.ch1" }),
      prefetch: vi.fn().mockResolvedValue(undefined),
      consume: vi.fn().mockResolvedValue({ consumerTag: "tag1" }),
      ack: vi.fn(),
      nack: vi.fn(),
      sendToQueue: vi.fn(() => true),
      close: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
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

    const pgClientMock = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue({ rows: [] }),
      end: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
    };

    const pgPoolMock = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      on: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined),
    };

    return {
      connectMock,
      channelMock,
      connectionMock,
      pgPoolMock,
      pgClientMock,
    };
  });

vi.mock("amqplib", () => ({ default: { connect: connectMock } }));
vi.mock("pg", () => ({
  Pool: vi.fn().mockImplementation(function () {
    return pgPoolMock;
  }),
  Client: vi.fn().mockImplementation(function () {
    return pgClientMock;
  }),
}));
vi.mock("../../config", () => ({
  config: {
    NUQ_RABBITMQ_URL: "amqp://test",
    NUQ_DATABASE_URL: "postgres://test",
    NUQ_WAIT_MODE: "listen",
  },
}));
vi.mock("./redis", () => ({
  nuqRedis: {
    shutdown: vi.fn().mockResolvedValue(undefined),
  },
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
vi.mock("../../lib/otel-tracer", () => ({
  withSpan: vi.fn((_name, cb) => cb({ setAttributes: vi.fn() })),
  setSpanAttributes: vi.fn(),
}));

function getListenerConnectionCloseHandler(): () => void {
  const call = (connectionMock.on as Mock).mock.calls.find(
    c => c[0] === "close",
  );
  return call?.[1] as () => void;
}

function getListenerConnectionErrorHandler(): (err: any) => void {
  const call = (connectionMock.on as Mock).mock.calls.find(
    c => c[0] === "error",
  );
  return call?.[1] as (err: any) => void;
}

function getListenerChannelErrorHandler(): (err: any) => void {
  const call = (channelMock.on as Mock).mock.calls.find(c => c[0] === "error");
  return call?.[1] as (err: any) => void;
}

async function freshNuQModule() {
  vi.resetModules();
  return import("./nuq.js");
}

describe("NuQ RabbitMQ listener and sender reconnect recovery (#5401)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue(connectionMock);
    connectionMock.createChannel.mockResolvedValue(channelMock);
    channelMock.assertQueue.mockResolvedValue({
      queue: "test_queue.listen.ch1",
    });
    channelMock.consume.mockResolvedValue({ consumerTag: "tag1" });
    channelMock.sendToQueue.mockReturnValue(true);
    pgPoolMock.query.mockResolvedValue({ rows: [] });
  });

  it("establishes listener with prefetch, exclusive queue and consumer", async () => {
    const { NuQ } = await freshNuQModule();
    const q = new NuQ("test_queue", {});

    const listener = vi.fn();
    // Access private addListener
    await (q as any).addListener("job-1", listener);

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(channelMock.prefetch).toHaveBeenCalledWith(5);
    expect(channelMock.assertQueue).toHaveBeenCalledWith(
      expect.stringContaining("test_queue.listen."),
      expect.objectContaining({
        exclusive: true,
        autoDelete: true,
        durable: false,
      }),
    );
    expect(channelMock.consume).toHaveBeenCalledTimes(1);

    // Verify error and close handlers are attached to both connection and channel
    expect(getListenerConnectionCloseHandler()).toBeTypeOf("function");
    expect(getListenerConnectionErrorHandler()).toBeTypeOf("function");
    expect(getListenerChannelErrorHandler()).toBeTypeOf("function");

    await q.shutdown();
  });

  it("survives broker restart: recovers consumer after initial ECONNREFUSED with exponential backoff", async () => {
    vi.useFakeTimers();
    try {
      const { NuQ } = await freshNuQModule();
      const q = new NuQ("test_queue", {});

      const listener = vi.fn();
      await (q as any).addListener("job-123", listener);
      expect(channelMock.consume).toHaveBeenCalledTimes(1);

      const onClose = getListenerConnectionCloseHandler();
      expect(onClose).toBeTypeOf("function");

      // Simulate RabbitMQ broker stopping: connection close triggers
      onClose();

      // First reconnect attempt after 250ms fails (broker still down during reboot)
      connectMock.mockRejectedValueOnce(
        new Error("connect ECONNREFUSED 127.0.0.1:5672"),
      );
      await vi.advanceTimersByTimeAsync(250);
      expect(connectMock).toHaveBeenCalledTimes(2);

      // Listener should not be restored yet, but should have scheduled next attempt with backoff (500ms)
      expect(channelMock.consume).toHaveBeenCalledTimes(1);

      // Advance 250ms (not yet 500ms) -> should NOT have reconnected yet
      await vi.advanceTimersByTimeAsync(250);
      expect(connectMock).toHaveBeenCalledTimes(2);

      // Broker is now back up! Next retry at +250ms (total 500ms from last failure) succeeds
      connectMock.mockResolvedValueOnce(connectionMock);
      await vi.advanceTimersByTimeAsync(250);

      // Verify reconnection succeeded
      expect(connectMock).toHaveBeenCalledTimes(3);
      expect(channelMock.consume).toHaveBeenCalledTimes(2);
      expect(channelMock.assertQueue).toHaveBeenCalledTimes(2);

      await q.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes backed up jobs from DB upon listener recovery", async () => {
    vi.useFakeTimers();
    try {
      const { NuQ } = await freshNuQModule();
      const q = new NuQ("test_queue", {});

      const listener = vi.fn();
      await (q as any).addListener("job-backed-up", listener);

      const onClose = getListenerConnectionCloseHandler();
      onClose();

      // Mock getJobs returning the completed job from Postgres while listener was down
      pgPoolMock.query.mockResolvedValueOnce({
        rows: [
          {
            id: "job-backed-up",
            status: "completed",
            created_at: new Date().toISOString(),
            priority: 10,
            data: {},
            returnvalue: { success: true },
          },
        ],
      });

      // Advance timer for reconnect
      await vi.advanceTimersByTimeAsync(250);

      // Verify the registered listener was notified of the completed job
      expect(listener).toHaveBeenCalledWith("completed");

      await q.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("deduplicates concurrent startListener calls using listenerPromise", async () => {
    const { NuQ } = await freshNuQModule();
    const q = new NuQ("test_queue", {});

    const p1 = (q as any).startListener();
    const p2 = (q as any).startListener();
    const p3 = (q as any).startListener();

    await Promise.all([p1, p2, p3]);

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(channelMock.consume).toHaveBeenCalledTimes(1);

    await q.shutdown();
  });

  it("deduplicates concurrent startSender calls using senderPromise", async () => {
    const { NuQ } = await freshNuQModule();
    const q = new NuQ("test_queue", {});

    const p1 = (q as any).startSender();
    const p2 = (q as any).startSender();
    const p3 = (q as any).startSender();

    await Promise.all([p1, p2, p3]);

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(channelMock.assertQueue).toHaveBeenCalledWith(
      "test_queue.prefetch",
      expect.anything(),
    );

    await q.shutdown();
  });

  it("cleans up reconnect timer and resources on shutdown", async () => {
    vi.useFakeTimers();
    try {
      const { NuQ } = await freshNuQModule();
      const q = new NuQ("test_queue", {});

      await (q as any).addListener("job-1", vi.fn());
      const onClose = getListenerConnectionCloseHandler();

      // Broker goes down
      connectMock.mockRejectedValue(new Error("broker down"));
      onClose();

      // Shutdown before reconnect fires
      await q.shutdown();

      // Advance timers significantly
      await vi.advanceTimersByTimeAsync(60000);

      // No reconnection calls should happen after shutdown
      expect(connectMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes leaked resources and does not leave stale listener on consume failure", async () => {
    const { NuQ } = await freshNuQModule();
    const q = new NuQ("test_queue", {});

    channelMock.consume.mockRejectedValueOnce(new Error("consume failed"));

    await expect((q as any).startListener()).rejects.toThrow("consume failed");

    expect((q as any).listener).toBeNull();
    expect(channelMock.close).toHaveBeenCalled();
    expect(connectionMock.close).toHaveBeenCalled();

    await q.shutdown();
  });

  it("awaits in-flight listener and sender startups on shutdown", async () => {
    const { NuQ } = await freshNuQModule();
    const q = new NuQ("test_queue", {});

    let resolveConnect: ((val: any) => void) | null = null;
    const delayedConnect = new Promise(resolve => {
      resolveConnect = resolve;
    });
    connectMock.mockReturnValueOnce(delayedConnect);

    const listenerPromise = (q as any).startListener();
    const shutdownPromise = q.shutdown();

    // Resolve after shutdown started
    resolveConnect!(connectionMock);

    await Promise.all([listenerPromise, shutdownPromise]);

    expect((q as any).listener).toBeNull();
  });
});
