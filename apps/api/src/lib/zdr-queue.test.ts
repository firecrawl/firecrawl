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

function message(body: unknown) {
  return {
    content: Buffer.from(
      typeof body === "string" ? body : JSON.stringify(body),
    ),
    fields: {},
    properties: {},
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

    await enqueueZdrCleanupJob("request-1");

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

  it("uses replicated queues and at-least-once delayed delivery", async () => {
    const { enqueueZdrCleanupJob, shutdownZdrQueue } = await import(
      "./zdr-queue.js"
    );

    await enqueueZdrCleanupJob("request-2");

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
      },
    });
    await shutdownZdrQueue();
  });

  it("acks completed jobs and requeues failures without a delivery cap", async () => {
    const { consumeZdrCleanupJobs, shutdownZdrQueue } = await import(
      "./zdr-queue.js"
    );
    const handler = vi.fn(async () => {});
    await consumeZdrCleanupJobs(handler);
    const consume = consumerCallbacks[0];

    const completed = message({ requestId: "request-3" });
    await consume(completed);
    expect(handler).toHaveBeenCalledWith({ requestId: "request-3" });
    expect(consumeChannel.ack).toHaveBeenCalledWith(completed);
    expect(spans).toContainEqual({
      name: "zdr.rabbitmq.consume",
      attributes: expect.objectContaining({
        "messaging.system": "rabbitmq",
        "messaging.destination.name": "zdr.cleanup.ready",
        "messaging.operation.name": "process",
        "zdr.request_id": "request-3",
        "zdr.rabbitmq.outcome": "acknowledged",
      }),
    });

    handler.mockRejectedValueOnce(new Error("GCS unavailable"));
    const failed = message({ requestId: "request-4" });
    await consume(failed);
    expect(consumeChannel.nack).toHaveBeenCalledWith(failed, false, true);

    const malformed = message("not-json");
    await consume(malformed);
    expect(consumeChannel.nack).toHaveBeenCalledWith(malformed, false, false);
    expect(recordSpanException).toHaveBeenCalled();
    await shutdownZdrQueue();
  });
});
