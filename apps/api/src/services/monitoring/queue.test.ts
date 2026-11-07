import type { Mock } from "vitest";

const { connectMock, channelMock, connectionMock } = vi.hoisted(() => {
  const channelMock = {
    assertExchange: vi.fn(),
    assertQueue: vi.fn(),
    bindQueue: vi.fn(),
    prefetch: vi.fn(),
    consume: vi.fn(),
    ack: vi.fn(),
    nack: vi.fn(),
    sendToQueue: vi.fn(() => true),
    close: vi.fn(),
    on: vi.fn(),
  };
  const connectionMock = {
    createChannel: vi.fn(() => channelMock),
    on: vi.fn(),
    close: vi.fn(),
  };
  const connectMock = vi.fn(() => connectionMock);
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
    child: () => mk(),
  });
  return { logger: mk() };
});

function consumeChannelCloseHandler(): () => void {
  const call = (channelMock.on as Mock).mock.calls.find(c => c[0] === "close");
  return call?.[1] as () => void;
}

async function freshQueueModule() {
  vi.resetModules();
  return import("./queue.js");
}

describe("monitoring queue (RabbitMQ wrapper)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockReturnValue(connectionMock);
    connectionMock.createChannel.mockReturnValue(channelMock);
    channelMock.sendToQueue.mockReturnValue(true);
  });

  it("subscribes the default consumer with per-consumer prefetch(1) and manual ack", async () => {
    const q = await freshQueueModule();
    await q.consumeMonitorCheckJobs(vi.fn());

    // Default (scrape/crawl/page/site/batch) checks just enqueue async jobs, so 1
    // is fine; global=false keeps the limit per-consumer on the shared channel.
    expect(channelMock.prefetch).toHaveBeenCalledWith(1, false);
    expect(channelMock.consume).toHaveBeenCalledTimes(1);
    const [queue, , opts] = channelMock.consume.mock.calls[0];
    expect(queue).toBe("monitor.checks");
    expect(opts).toEqual({ noAck: false });
  });

  it("subscribes the search consumer with a higher prefetch so inline checks run concurrently", async () => {
    const q = await freshQueueModule();
    await q.consumeMonitorSearchCheckJobs(vi.fn());

    // Search checks run inline for 15-50s, so prefetch(1) would serialize a burst.
    expect(channelMock.prefetch).toHaveBeenCalledWith(3, false);
    const [queue] = channelMock.consume.mock.calls[0];
    expect(queue).toBe("monitor.checks.search");
  });

  it("dedups a repeat subscribe to the same queue (no duplicate consumer)", async () => {
    const q = await freshQueueModule();
    await q.consumeMonitorCheckJobs(vi.fn());
    await q.consumeMonitorCheckJobs(vi.fn());

    expect(channelMock.consume).toHaveBeenCalledTimes(1);
  });

  it("acks on a successful handler, nacks (no requeue) when the handler throws", async () => {
    const q = await freshQueueModule();
    const ok = vi.fn().mockResolvedValue(undefined);
    await q.consumeMonitorCheckJobs(ok);
    const onMessage = channelMock.consume.mock.calls[0][1];

    const msg = {
      content: Buffer.from(
        JSON.stringify({ monitorId: "m1", checkId: "c1", teamId: "t1" }),
      ),
    };
    await onMessage(msg);
    expect(ok).toHaveBeenCalledWith({
      monitorId: "m1",
      checkId: "c1",
      teamId: "t1",
    });
    expect(channelMock.ack).toHaveBeenCalledWith(msg);
    expect(channelMock.nack).not.toHaveBeenCalled();

    const boom = vi.fn().mockRejectedValue(new Error("handler boom"));
    const q2mod = q;
    await q2mod.consumeMonitorSearchCheckJobs(boom);
    const onSearchMessage = channelMock.consume.mock.calls.at(-1)![1];
    const msg2 = {
      content: Buffer.from(
        JSON.stringify({ monitorId: "m2", checkId: "c2", teamId: "t2" }),
      ),
    };
    await onSearchMessage(msg2);
    expect(boom).toHaveBeenCalled();
    expect(channelMock.nack).toHaveBeenCalledWith(msg2, false, false);
  });

  it("re-subscribes the consumer after a channel drop (does not go deaf)", async () => {
    vi.useFakeTimers();
    try {
      const q = await freshQueueModule();
      await q.consumeMonitorCheckJobs(vi.fn());
      expect(channelMock.consume).toHaveBeenCalledTimes(1);

      const onClose = consumeChannelCloseHandler();
      expect(onClose).toBeTypeOf("function");
      onClose();

      // Reconnect is on a backoff timer; advance past it.
      await vi.advanceTimersByTimeAsync(1500);

      expect(channelMock.consume.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(channelMock.consume.mock.calls.at(-1)![0]).toBe("monitor.checks");
    } finally {
      vi.useRealTimers();
    }
  });
});
