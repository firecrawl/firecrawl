import type { Mock } from "vitest";
import type { ScrapeActivityEvent } from "./types";

const { connectMock, channelMock, connectionMock } = vi.hoisted(() => {
  const channelMock = {
    assertExchange: vi.fn(),
    assertQueue: vi.fn(),
    bindQueue: vi.fn(),
    prefetch: vi.fn(),
    consume: vi.fn(),
    ack: vi.fn(),
    nack: vi.fn(),
    // Confirm-channel shape: the last argument is the broker's ack callback.
    publish: vi.fn((...args: unknown[]) => {
      const callback = args[4];
      if (typeof callback === "function") {
        (callback as (error: Error | null) => void)(null);
      }
      return true;
    }),
    close: vi.fn(),
    on: vi.fn(),
  };
  // Async like the real client, so a test can hold a connection open mid-connect.
  const connectionMock = {
    createChannel: vi.fn(async () => channelMock),
    createConfirmChannel: vi.fn(async () => channelMock),
    on: vi.fn(),
    close: vi.fn(async () => {}),
  };
  const connectMock = vi.fn(() => connectionMock);
  return { connectMock, channelMock, connectionMock };
});

vi.mock("amqplib", () => ({ default: { connect: connectMock } }));
vi.mock("../../config", () => ({
  config: { NUQ_RABBITMQ_URL: "amqp://test" },
}));
// Each test re-imports the module under test, and prom-client rejects a second
// registration of the same counter name in one registry.
const { metricsMock } = vi.hoisted(() => ({ metricsMock: { inc: vi.fn() } }));
vi.mock("./metrics", () => ({ siemLoggingEventsTotal: metricsMock }));
vi.mock("../logger", () => {
  const mk = (): Record<string, unknown> => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => mk(),
  });
  return { logger: mk() };
});

function event(scrapeId: string): ScrapeActivityEvent {
  return {
    schema_version: 1,
    event_type: "scrape_activity",
    scrape_id: scrapeId,
    request_id: "request-id",
    endpoint: "scrape",
    team_id: "team-id",
    org_id: "org-id",
    api_key: { id: null, name: null },
    started_at: "2026-07-27T00:00:00.000Z",
    completed_at: "2026-07-27T00:00:01.000Z",
    url: "https://example.com",
    domain: "example.com",
    http_method: "GET",
    http_status: 200,
    result: "success",
    error: null,
    origin: "api",
    integration: null,
    zero_data_retention: false,
  };
}

function message(orgId: string, scrapeId: string, attempt = 0) {
  return {
    content: Buffer.from(JSON.stringify({ orgId, event: event(scrapeId) })),
    properties: {
      messageId: scrapeId,
      headers: { "x-siem-attempt": attempt },
    },
  };
}

async function freshTransport() {
  vi.resetModules();
  return import("./transport.js");
}

function assertedQueue(name: string) {
  const call = (channelMock.assertQueue as Mock).mock.calls.find(
    c => c[0] === name,
  );
  return call?.[1] as { arguments?: Record<string, unknown> } | undefined;
}

describe("SIEM logging transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockReturnValue(connectionMock);
    connectionMock.createChannel.mockResolvedValue(channelMock);
    connectionMock.createConfirmChannel.mockResolvedValue(channelMock);
  });

  it("bounds the event queue in the broker instead of in memory", async () => {
    const transport = await freshTransport();
    await transport.enqueueSiemLoggingEvent("org-a", event("scrape-1"));

    const main = assertedQueue("siem.logging.events");
    expect(main?.arguments).toMatchObject({
      "x-max-length": 100_000,
      "x-overflow": "drop-head",
      "x-dead-letter-exchange": "siem.logging.dlx",
    });
    // Every retry rung is bounded too, so a wedged destination can't turn the
    // ladder into unbounded storage.
    for (const delayMs of [5_000, 30_000, 300_000, 1_800_000]) {
      expect(
        assertedQueue(`siem.logging.events.retry.${delayMs}`)?.arguments,
      ).toMatchObject({
        "x-message-ttl": delayMs,
        "x-max-length": 100_000,
        "x-overflow": "drop-head",
        "x-dead-letter-exchange": "siem.logging",
      });
    }
  });

  it("batches an organization's events into one handler call on the linger", async () => {
    vi.useFakeTimers();
    try {
      const transport = await freshTransport();
      const handler = vi.fn().mockResolvedValue({ disposition: "done" });
      await transport.consumeSiemLoggingEvents(handler, {
        batchSize: 10,
        batchLingerMs: 1000,
      });
      const onMessage = channelMock.consume.mock.calls[0][1];

      const first = message("org-a", "scrape-1");
      const second = message("org-a", "scrape-2");
      await onMessage(first);
      await onMessage(second);
      expect(handler).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000);

      expect(handler).toHaveBeenCalledOnce();
      const [orgId, events] = handler.mock.calls[0];
      expect(orgId).toBe("org-a");
      expect(events.map((e: ScrapeActivityEvent) => e.scrape_id)).toEqual([
        "scrape-1",
        "scrape-2",
      ]);
      expect(channelMock.ack).toHaveBeenCalledWith(first);
      expect(channelMock.ack).toHaveBeenCalledWith(second);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never mixes organizations in one batch", async () => {
    vi.useFakeTimers();
    try {
      const transport = await freshTransport();
      const handler = vi.fn().mockResolvedValue({ disposition: "done" });
      await transport.consumeSiemLoggingEvents(handler, {
        batchSize: 10,
        batchLingerMs: 1000,
      });
      const onMessage = channelMock.consume.mock.calls[0][1];

      await onMessage(message("org-a", "scrape-1"));
      await onMessage(message("org-b", "scrape-2"));
      await vi.advanceTimersByTimeAsync(1000);

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler.mock.calls.map(c => c[0]).sort()).toEqual([
        "org-a",
        "org-b",
      ]);
      for (const [, events] of handler.mock.calls) {
        expect(events).toHaveLength(1);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes early once a batch reaches its size ceiling", async () => {
    vi.useFakeTimers();
    try {
      const transport = await freshTransport();
      const handler = vi.fn().mockResolvedValue({ disposition: "done" });
      await transport.consumeSiemLoggingEvents(handler, {
        batchSize: 2,
        batchLingerMs: 60_000,
      });
      const onMessage = channelMock.consume.mock.calls[0][1];

      await onMessage(message("org-a", "scrape-1"));
      await onMessage(message("org-a", "scrape-2"));

      // No timer advance: the size ceiling closed the batch.
      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][1]).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves prefetch large enough to fill a batch", async () => {
    const transport = await freshTransport();
    await transport.consumeSiemLoggingEvents(vi.fn(), { batchSize: 50 });

    const [prefetch, global] = channelMock.prefetch.mock.calls[0];
    expect(prefetch).toBeGreaterThanOrEqual(50);
    expect(global).toBe(false);
  });

  it("republishes a retry onto the next ladder rung and acks the original", async () => {
    const transport = await freshTransport();
    await transport.consumeSiemLoggingEvents(
      vi.fn().mockResolvedValue({ disposition: "retry" }),
      { batchSize: 1 },
    );
    const onMessage = channelMock.consume.mock.calls[0][1];

    const msg = message("org-a", "scrape-1", 1);
    await onMessage(msg);

    const retryPublish = channelMock.publish.mock.calls.find(
      c => c[0] === "siem.logging.retry",
    );
    expect(retryPublish?.[1]).toBe("siem.logging.events.retry.30000");
    expect(retryPublish?.[3]).toMatchObject({
      headers: { "x-siem-attempt": 2 },
    });
    // Acked, not nacked: a requeue would redeliver immediately and spin against
    // a destination that is still down.
    expect(channelMock.ack).toHaveBeenCalledWith(msg);
    expect(channelMock.nack).not.toHaveBeenCalled();
  });

  it("rounds a Retry-After up to the smallest rung that satisfies it", async () => {
    const transport = await freshTransport();
    await transport.consumeSiemLoggingEvents(
      vi.fn().mockResolvedValue({ disposition: "retry", retryAfterMs: 20_000 }),
      { batchSize: 1 },
    );
    const onMessage = channelMock.consume.mock.calls[0][1];

    await onMessage(message("org-a", "scrape-1"));

    const retryPublish = channelMock.publish.mock.calls.find(
      c => c[0] === "siem.logging.retry",
    );
    expect(retryPublish?.[1]).toBe("siem.logging.events.retry.30000");
  });

  it("dead-letters once the ladder is exhausted", async () => {
    const transport = await freshTransport();
    await transport.consumeSiemLoggingEvents(
      vi.fn().mockResolvedValue({ disposition: "retry" }),
      { batchSize: 1 },
    );
    const onMessage = channelMock.consume.mock.calls[0][1];

    const msg = message("org-a", "scrape-1", 4);
    await onMessage(msg);

    expect(
      channelMock.publish.mock.calls.some(c => c[0] === "siem.logging.retry"),
    ).toBe(false);
    expect(channelMock.nack).toHaveBeenCalledWith(msg, false, false);
  });

  it("dead-letters a permanent failure without touching the ladder", async () => {
    const transport = await freshTransport();
    await transport.consumeSiemLoggingEvents(
      vi.fn().mockResolvedValue({ disposition: "drop" }),
      { batchSize: 1 },
    );
    const onMessage = channelMock.consume.mock.calls[0][1];

    const msg = message("org-a", "scrape-1");
    await onMessage(msg);

    expect(
      channelMock.publish.mock.calls.some(c => c[0] === "siem.logging.retry"),
    ).toBe(false);
    expect(channelMock.nack).toHaveBeenCalledWith(msg, false, false);
  });

  it("retries the batch when the handler throws", async () => {
    const transport = await freshTransport();
    await transport.consumeSiemLoggingEvents(
      vi.fn().mockRejectedValue(new Error("handler boom")),
      { batchSize: 1 },
    );
    const onMessage = channelMock.consume.mock.calls[0][1];

    await onMessage(message("org-a", "scrape-1"));

    expect(
      channelMock.publish.mock.calls.some(c => c[0] === "siem.logging.retry"),
    ).toBe(true);
  });

  it("fails the enqueue when the broker nacks the publish", async () => {
    const transport = await freshTransport();
    channelMock.publish.mockImplementationOnce((...args: unknown[]) => {
      (args[4] as (error: Error | null) => void)(new Error("nacked"));
      return true;
    });

    await expect(
      transport.enqueueSiemLoggingEvent("org-a", event("scrape-1")),
    ).rejects.toThrow("Failed to publish 1 of 1");
    expect(metricsMock.inc).toHaveBeenCalledWith(
      { result: "enqueue_failed" },
      1,
    );
  });

  it("leaves a message unsettled when its retry republish is not confirmed", async () => {
    const transport = await freshTransport();
    await transport.consumeSiemLoggingEvents(
      vi.fn().mockResolvedValue({ disposition: "retry" }),
      { batchSize: 1 },
    );
    const onMessage = channelMock.consume.mock.calls[0][1];
    channelMock.publish.mockImplementationOnce((...args: unknown[]) => {
      (args[4] as (error: Error | null) => void)(new Error("nacked"));
      return true;
    });

    const msg = message("org-a", "scrape-1");
    await onMessage(msg);

    // Neither acked nor dead-lettered: the broker redelivers it instead of the
    // event vanishing between a lost republish and an ack.
    expect(channelMock.ack).not.toHaveBeenCalled();
    expect(channelMock.nack).not.toHaveBeenCalled();
  });

  it("dead-letters an unparseable message instead of hot-looping it", async () => {
    const transport = await freshTransport();
    await transport.consumeSiemLoggingEvents(vi.fn(), { batchSize: 1 });
    const onMessage = channelMock.consume.mock.calls[0][1];

    const msg = { content: Buffer.from("not json"), properties: {} };
    await onMessage(msg);

    expect(channelMock.nack).toHaveBeenCalledWith(msg, false, false);
  });

  it("dead-letters well-formed JSON that is not a SIEM message", async () => {
    const transport = await freshTransport();
    const handler = vi.fn();
    await transport.consumeSiemLoggingEvents(handler, { batchSize: 1 });
    const onMessage = channelMock.consume.mock.calls[0][1];

    const msg = {
      content: Buffer.from(JSON.stringify({ event: event("scrape-1") })),
      properties: {},
    };
    await onMessage(msg);

    expect(handler).not.toHaveBeenCalled();
    expect(channelMock.nack).toHaveBeenCalledWith(msg, false, false);
  });

  it("counts the accepted events when only some publishes are nacked", async () => {
    const transport = await freshTransport();
    channelMock.publish.mockImplementationOnce((...args: unknown[]) => {
      (args[4] as (error: Error | null) => void)(new Error("nacked"));
      return true;
    });

    // Rejects, but the sibling event was accepted — the aggregate must not
    // report the whole call as failed.
    await expect(
      transport.enqueueSiemLoggingEvents("org-a", [
        event("scrape-1"),
        event("scrape-2"),
      ]),
    ).rejects.toThrow("Failed to publish 1 of 2");
    expect(metricsMock.inc).toHaveBeenCalledWith({ result: "queued" }, 1);
    expect(metricsMock.inc).toHaveBeenCalledWith(
      { result: "enqueue_failed" },
      1,
    );
  });

  it("publishes as mandatory and reports what the broker cannot route", async () => {
    const transport = await freshTransport();
    await transport.enqueueSiemLoggingEvent("org-a", event("scrape-1"));

    expect(channelMock.publish.mock.calls[0][3]).toMatchObject({
      mandatory: true,
    });

    const onReturn = (channelMock.on as Mock).mock.calls.find(
      c => c[0] === "return",
    )?.[1] as (msg: unknown) => void;
    expect(onReturn).toBeTypeOf("function");
    onReturn({
      fields: { exchange: "siem.logging", routingKey: "siem.logging.events" },
      properties: { messageId: "scrape-1" },
    });
    expect(metricsMock.inc).toHaveBeenCalledWith({ result: "unroutable" });
  });

  it("retries the subscribe when the broker is down at startup", async () => {
    vi.useFakeTimers();
    try {
      const transport = await freshTransport();
      connectMock.mockImplementationOnce(() => {
        throw new Error("broker down");
      });

      // Must resolve, not reject: an unavailable broker at boot has to enter the
      // reconnect loop instead of leaving the replica permanently deaf.
      await expect(
        transport.consumeSiemLoggingEvents(vi.fn(), { batchSize: 1 }),
      ).resolves.toBeUndefined();
      expect(channelMock.consume).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1500);

      expect(channelMock.consume).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not subscribe when shutdown races the initial connection", async () => {
    const transport = await freshTransport();
    let releaseChannel!: () => void;
    connectionMock.createChannel.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          releaseChannel = () => resolve(channelMock);
        }),
    );

    const subscribing = transport.consumeSiemLoggingEvents(vi.fn(), {
      batchSize: 1,
    });
    await vi.waitFor(() =>
      expect(connectionMock.createChannel).toHaveBeenCalled(),
    );

    // Shutdown lands while that first channel is still opening.
    await transport.closeSiemLoggingTransport();
    releaseChannel();
    await subscribing;

    expect(channelMock.consume).not.toHaveBeenCalled();
    expect(connectionMock.close).toHaveBeenCalled();
  });

  it("does not reopen the transport when shutdown races a pending reconnect", async () => {
    vi.useFakeTimers();
    try {
      const transport = await freshTransport();
      connectMock.mockImplementationOnce(() => {
        throw new Error("broker down");
      });
      await transport.consumeSiemLoggingEvents(vi.fn(), { batchSize: 1 });

      await transport.closeSiemLoggingTransport();
      await vi.advanceTimersByTimeAsync(5000);

      // The pending reconnect timer must not resurrect a connection that
      // shutdown already tore down.
      expect(channelMock.consume).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-subscribes the consumer after a channel drop (does not go deaf)", async () => {
    vi.useFakeTimers();
    try {
      const transport = await freshTransport();
      await transport.consumeSiemLoggingEvents(vi.fn(), { batchSize: 1 });
      expect(channelMock.consume).toHaveBeenCalledTimes(1);

      const onClose = (channelMock.on as Mock).mock.calls.find(
        c => c[0] === "close",
      )?.[1] as () => void;
      expect(onClose).toBeTypeOf("function");
      onClose();

      await vi.advanceTimersByTimeAsync(1500);

      expect(channelMock.consume.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
