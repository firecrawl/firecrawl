import { vi, type Mock } from "vitest";

const {
  connect,
  connection,
  publishChannel,
  consumeChannel,
  consumerCallbacks,
  spans,
  withSpan,
  setSpanAttributes,
  recordSpanException,
  publishEvents,
} = vi.hoisted(() => {
  const consumerCallbacks: Array<(message: any) => Promise<void>> = [];
  const publishEvents = new Map<string, (...args: any[]) => void>();
  const spans: Array<{ name: string; attributes: Record<string, unknown> }> =
    [];
  const withSpan = vi.fn(async (name: string, fn: (span: any) => any) => {
    const span = { attributes: {} };
    spans.push({ name, attributes: span.attributes });
    return fn(span);
  });
  const setSpanAttributes = vi.fn(
    (span: { attributes: Record<string, unknown> }, attributes: object) => {
      Object.assign(span.attributes, attributes);
    },
  );
  const publishChannel: any = {
    assertExchange: vi.fn(async () => {}),
    assertQueue: vi.fn(async () => ({})),
    bindQueue: vi.fn(async () => {}),
    sendToQueue: vi.fn(
      (_queue: string, _content: Buffer, _options: any, callback: any) => {
        callback(null);
        return true;
      },
    ),
    close: vi.fn(async () => {}),
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      publishEvents.set(event, handler);
    }),
  };
  const consumeChannel: any = {
    assertExchange: vi.fn(async () => {}),
    assertQueue: vi.fn(async () => ({})),
    bindQueue: vi.fn(async () => {}),
    prefetch: vi.fn(async () => {}),
    consume: vi.fn(async (_queue: string, callback: any) => {
      consumerCallbacks.push(callback);
      return { consumerTag: "zdr-test" };
    }),
    ack: vi.fn(),
    nack: vi.fn(),
    close: vi.fn(async () => {}),
    on: vi.fn(),
  };
  const connection: any = {
    createConfirmChannel: vi.fn(async () => publishChannel),
    createChannel: vi.fn(async () => consumeChannel),
    close: vi.fn(async () => {}),
    on: vi.fn(),
  };
  return {
    connect: vi.fn(async () => connection),
    connection,
    publishChannel,
    consumeChannel,
    consumerCallbacks,
    spans,
    withSpan,
    setSpanAttributes,
    recordSpanException: vi.fn(),
    publishEvents,
  };
});

vi.mock("amqplib", () => ({ default: { connect } }));
vi.mock("../config", () => ({
  config: { NUQ_RABBITMQ_URL: "amqp://rabbitmq" },
}));
vi.mock("./logger", () => {
  const logger: any = {
    child: vi.fn(() => logger),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return { logger };
});
vi.mock("./otel-tracer", () => ({
  withSpan,
  setSpanAttributes,
  recordSpanException,
}));

function message(
  body: unknown,
  headers?: Record<string, unknown>,
  redelivered = false,
) {
  return {
    content: Buffer.from(
      typeof body === "string" ? body : JSON.stringify(body),
    ),
    fields: { redelivered },
    properties: { headers },
  };
}

describe("ZDR cleanup queue", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    consumerCallbacks.length = 0;
    publishEvents.clear();
    spans.length = 0;
  });

  it("publishes persistent jobs only after a broker confirm", async () => {
    const { enqueueZdrCleanupJob, shutdownZdrQueue } = await import(
      "./zdr-queue.js"
    );

    await enqueueZdrCleanupJob({ requestId: "request-1" });

    expect(connect).toHaveBeenCalledWith(
      "amqp://rabbitmq",
      expect.objectContaining({
        clientProperties: { connection_name: "zdr-cleanup" },
      }),
    );
    expect(publishChannel.sendToQueue).toHaveBeenCalledWith(
      "zdr.cleanup.delayed.24h",
      Buffer.from(JSON.stringify({ requestId: "request-1" })),
      expect.objectContaining({
        persistent: true,
        messageId: "request-1",
        correlationId: expect.any(String),
        timestamp: expect.any(Number),
        mandatory: true,
        headers: { "zdr-attempt": 1 },
      }),
      expect.any(Function),
    );
    expect(spans).toContainEqual({
      name: "zdr.rabbitmq.publish",
      attributes: expect.objectContaining({
        "messaging.system": "rabbitmq",
        "messaging.destination.name": "zdr.cleanup.delayed.24h",
        "messaging.operation.name": "publish",
        "messaging.message.id": "request-1",
        "zdr.rabbitmq.outcome": "confirmed",
      }),
    });
    await shutdownZdrQueue();
  });

  it("publishes a per-blob job to the same 24h delay queue", async () => {
    const { enqueueZdrCleanupJob, shutdownZdrQueue } = await import(
      "./zdr-queue.js"
    );

    await enqueueZdrCleanupJob({ blobId: "blob-1" });

    expect(publishChannel.sendToQueue).toHaveBeenCalledWith(
      "zdr.cleanup.delayed.24h",
      Buffer.from(JSON.stringify({ blobId: "blob-1" })),
      expect.objectContaining({
        persistent: true,
        messageId: "blob-1",
        mandatory: true,
        headers: { "zdr-attempt": 1 },
      }),
      expect.any(Function),
    );
    await shutdownZdrQueue();
  });

  it("retries a mandatory publish returned as unroutable", async () => {
    vi.useFakeTimers();
    try {
      publishChannel.sendToQueue.mockImplementationOnce(
        (
          _queue: string,
          _content: Buffer,
          options: { correlationId: string },
          callback: (error: Error | null) => void,
        ) => {
          publishEvents.get("return")?.({
            properties: { correlationId: options.correlationId },
          });
          callback(null);
          return true;
        },
      );
      const { enqueueZdrCleanupJob, shutdownZdrQueue } = await import(
        "./zdr-queue.js"
      );

      const enqueue = enqueueZdrCleanupJob({ requestId: "request-returned" });
      await vi.runAllTimersAsync();
      await enqueue;

      expect(publishChannel.sendToQueue).toHaveBeenCalledTimes(2);
      await shutdownZdrQueue();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses replicated queues and at-least-once delayed delivery", async () => {
    const { enqueueZdrCleanupJob, shutdownZdrQueue } = await import(
      "./zdr-queue.js"
    );

    await enqueueZdrCleanupJob({ requestId: "request-2" });

    const queueDeclarations = new Map(
      (publishChannel.assertQueue as Mock).mock.calls.map(([name, options]) => [
        name,
        options,
      ]),
    );
    expect(queueDeclarations.get("zdr.cleanup.delayed.24h")).toMatchObject({
      durable: true,
      arguments: {
        "x-queue-type": "quorum",
        "x-overflow": "reject-publish",
        "x-message-ttl": 86_400_000,
        "x-dead-letter-strategy": "at-least-once",
        "x-dead-letter-exchange": "zdr.cleanup",
        "x-dead-letter-routing-key": "ready",
      },
    });
    expect(queueDeclarations.get("zdr.cleanup.ready")).toMatchObject({
      durable: true,
      arguments: {
        "x-queue-type": "quorum",
        "x-overflow": "reject-publish",
        "x-delivery-limit": -1,
        "x-dead-letter-exchange": "zdr.cleanup",
        "x-dead-letter-routing-key": "dead",
      },
    });
    expect(queueDeclarations.get("zdr.cleanup.retry")).toMatchObject({
      durable: true,
      arguments: {
        "x-queue-type": "quorum",
        "x-overflow": "reject-publish",
        "x-message-ttl": 300_000,
        "x-dead-letter-strategy": "at-least-once",
        "x-dead-letter-exchange": "zdr.cleanup",
        "x-dead-letter-routing-key": "ready",
      },
    });
    await shutdownZdrQueue();
  });

  it("hands request-level and per-blob jobs to the handler and acks them", async () => {
    const { consumeZdrCleanupJobs, shutdownZdrQueue } = await import(
      "./zdr-queue.js"
    );
    const handler = vi.fn(async () => {});
    await consumeZdrCleanupJobs(handler);
    const consume = consumerCallbacks[0];

    const requestJob = message({ requestId: "request-3" });
    await consume(requestJob);
    const blobJob = message({ blobId: "blob-3" });
    await consume(blobJob);

    expect(handler.mock.calls).toEqual([
      [{ requestId: "request-3" }],
      [{ blobId: "blob-3" }],
    ]);
    expect(consumeChannel.ack).toHaveBeenCalledWith(requestJob);
    expect(consumeChannel.ack).toHaveBeenCalledWith(blobJob);
    expect(consumeChannel.nack).not.toHaveBeenCalled();
    const consumeSpans = spans.filter(
      span => span.name === "zdr.rabbitmq.consume",
    );
    expect(consumeSpans.map(span => span.attributes)).toEqual([
      expect.objectContaining({
        "messaging.destination.name": "zdr.cleanup.ready",
        "messaging.operation.name": "process",
        "zdr.request_id": "request-3",
        "zdr.attempt": 1,
        "zdr.rabbitmq.outcome": "acknowledged",
      }),
      expect.objectContaining({
        "zdr.blob_id": "blob-3",
        "zdr.attempt": 1,
        "zdr.rabbitmq.outcome": "acknowledged",
      }),
    ]);
    expect(consumeSpans[1].attributes).not.toHaveProperty("zdr.request_id");
    await shutdownZdrQueue();
  });

  it("schedules a delayed retry instead of requeueing a failed job", async () => {
    const { consumeZdrCleanupJobs, shutdownZdrQueue } = await import(
      "./zdr-queue.js"
    );
    const handler = vi.fn(async () => {
      throw new Error("GCS unavailable");
    });
    await consumeZdrCleanupJobs(handler);
    const consume = consumerCallbacks[0];

    const firstFailure = message({ blobId: "blob-4" });
    await consume(firstFailure);
    const laterFailure = message(
      { requestId: "request-4" },
      { "zdr-attempt": 5 },
    );
    await consume(laterFailure);

    expect(publishChannel.sendToQueue).toHaveBeenNthCalledWith(
      1,
      "zdr.cleanup.retry",
      Buffer.from(JSON.stringify({ blobId: "blob-4" })),
      expect.objectContaining({
        persistent: true,
        messageId: "blob-4",
        mandatory: true,
        headers: { "zdr-attempt": 2 },
      }),
      expect.any(Function),
    );
    expect(publishChannel.sendToQueue).toHaveBeenNthCalledWith(
      2,
      "zdr.cleanup.retry",
      Buffer.from(JSON.stringify({ requestId: "request-4" })),
      expect.objectContaining({ headers: { "zdr-attempt": 6 } }),
      expect.any(Function),
    );
    expect(consumeChannel.ack).toHaveBeenCalledWith(firstFailure);
    expect(consumeChannel.ack).toHaveBeenCalledWith(laterFailure);
    expect(consumeChannel.nack).not.toHaveBeenCalled();
    expect(recordSpanException).toHaveBeenCalledTimes(2);
    expect(spans).toContainEqual({
      name: "zdr.rabbitmq.consume",
      attributes: expect.objectContaining({
        "zdr.blob_id": "blob-4",
        "zdr.rabbitmq.outcome": "retry_scheduled",
      }),
    });
    await shutdownZdrQueue();
  });

  it("dead-letters a job that fails its last attempt", async () => {
    const { consumeZdrCleanupJobs, shutdownZdrQueue } = await import(
      "./zdr-queue.js"
    );
    const handler = vi.fn(async () => {
      throw new Error("GCS unavailable");
    });
    await consumeZdrCleanupJobs(handler);
    const consume = consumerCallbacks[0];

    const exhausted = message({ blobId: "blob-5" }, { "zdr-attempt": 24 });
    await consume(exhausted);

    expect(handler).toHaveBeenCalledOnce();
    expect(consumeChannel.nack).toHaveBeenCalledWith(exhausted, false, false);
    expect(consumeChannel.ack).not.toHaveBeenCalled();
    expect(publishChannel.sendToQueue).not.toHaveBeenCalled();
    expect(spans).toContainEqual({
      name: "zdr.rabbitmq.consume",
      attributes: expect.objectContaining({
        "zdr.blob_id": "blob-5",
        "zdr.attempt": 24,
        "zdr.rabbitmq.outcome": "dead_lettered",
      }),
    });
    await shutdownZdrQueue();
  });

  it("counts an unsettled redelivery as a failed attempt", async () => {
    const { consumeZdrCleanupJobs, shutdownZdrQueue } = await import(
      "./zdr-queue.js"
    );
    const handler = vi.fn(async () => {});
    await consumeZdrCleanupJobs(handler);
    const consume = consumerCallbacks[0];

    const redelivered = message(
      { blobId: "blob-6" },
      { "zdr-attempt": 3 },
      true,
    );
    await consume(redelivered);
    const lastRedelivery = message(
      { blobId: "blob-7" },
      { "zdr-attempt": 24 },
      true,
    );
    await consume(lastRedelivery);

    expect(handler).not.toHaveBeenCalled();
    expect(publishChannel.sendToQueue).toHaveBeenCalledOnce();
    expect(publishChannel.sendToQueue).toHaveBeenCalledWith(
      "zdr.cleanup.retry",
      Buffer.from(JSON.stringify({ blobId: "blob-6" })),
      expect.objectContaining({ headers: { "zdr-attempt": 4 } }),
      expect.any(Function),
    );
    expect(consumeChannel.ack).toHaveBeenCalledWith(redelivered);
    expect(consumeChannel.nack).toHaveBeenCalledWith(
      lastRedelivery,
      false,
      false,
    );
    await shutdownZdrQueue();
  });

  it("dead-letters malformed and invalid jobs without calling the handler", async () => {
    const { consumeZdrCleanupJobs, shutdownZdrQueue } = await import(
      "./zdr-queue.js"
    );
    const handler = vi.fn(async () => {});
    await consumeZdrCleanupJobs(handler);
    const consume = consumerCallbacks[0];

    const malformed = message("not-json");
    const emptyBlob = message({ blobId: "" });
    const unknownShape = message({ jobId: "job-1" });
    await consume(malformed);
    await consume(emptyBlob);
    await consume(unknownShape);

    expect(handler).not.toHaveBeenCalled();
    expect(consumeChannel.nack).toHaveBeenCalledWith(malformed, false, false);
    expect(consumeChannel.nack).toHaveBeenCalledWith(emptyBlob, false, false);
    expect(consumeChannel.nack).toHaveBeenCalledWith(
      unknownShape,
      false,
      false,
    );
    expect(recordSpanException).toHaveBeenCalledTimes(3);
    await shutdownZdrQueue();
  });
});
