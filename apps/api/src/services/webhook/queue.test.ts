import { vi } from "vitest";

const { connect, connection, channel, listeners, sends } = vi.hoisted(() => {
  const listeners = new Map<string, (...args: any[]) => void>();
  const sends: Array<{
    options: Record<string, unknown>;
    confirm: (error: Error | null) => void;
  }> = [];
  const channel = {
    checkQueue: vi.fn(async () => ({})),
    sendToQueue: vi.fn(
      (
        _queue: string,
        _body: Buffer,
        options: Record<string, unknown>,
        confirm: (error: Error | null) => void,
      ) => {
        sends.push({ options, confirm });
        return true;
      },
    ),
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      listeners.set(event, handler);
    }),
    removeListener: vi.fn(
      (event: string, handler: (...args: any[]) => void) => {
        if (listeners.get(event) === handler) listeners.delete(event);
      },
    ),
    close: vi.fn(async () => {}),
  };
  const connection = {
    createConfirmChannel: vi.fn(async () => channel),
    on: vi.fn(),
    close: vi.fn(async () => {}),
  };
  return {
    connect: vi.fn(async () => connection),
    connection,
    channel,
    listeners,
    sends,
  };
});

vi.mock("amqplib", () => ({ default: { connect } }));
vi.mock("../../config", () => ({
  config: { NUQ_RABBITMQ_URL: "amqp://test" },
}));
vi.mock("../../lib/logger", () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger };
});

const message = {
  webhook_url: "https://example.com/webhook",
  payload: {
    success: true,
    type: "crawl.completed",
    webhookId: "webhook-1",
    data: [],
  },
  headers: {},
  team_id: "team-1",
  job_id: "job-1",
  scrape_id: null,
  event: "crawl.completed",
  timeout_ms: 10000,
};

describe("webhook RabbitMQ publisher", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    listeners.clear();
    sends.length = 0;
    channel.sendToQueue.mockImplementation(
      (_queue, _body, options, confirm) => {
        sends.push({ options, confirm });
        return true;
      },
    );
  });

  afterEach(() => vi.useRealTimers());

  async function startPublish() {
    const { webhookQueue } = await import("./queue");
    const result = webhookQueue.publish(message as any);
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    return { result };
  }

  it("reports queued only after the broker confirms a persistent message", async () => {
    const { result } = await startPublish();
    let resolved = false;
    void result.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(connection.createConfirmChannel).toHaveBeenCalledOnce();
    expect(channel.checkQueue).toHaveBeenCalledWith("webhooks");
    expect(sends[0].options).toMatchObject({
      persistent: true,
      mandatory: true,
      contentType: "application/json",
    });
    sends[0].confirm(null);
    await expect(result).resolves.toBeUndefined();
  });

  it("rejects a broker nack instead of reporting a queued webhook", async () => {
    const { result } = await startPublish();
    sends[0].confirm(new Error("broker nack"));
    await expect(result).rejects.toThrow("broker nack");
  });

  it("rejects an unroutable mandatory message even when it is acked", async () => {
    const { result } = await startPublish();
    listeners.get("return")?.({
      properties: { correlationId: sends[0].options.correlationId },
    });
    sends[0].confirm(null);
    await expect(result).rejects.toThrow("unroutable webhook message");
  });

  it("fails a publish if the broker never confirms it", async () => {
    const { webhookQueue } = await import("./queue");
    vi.useFakeTimers();
    const result = webhookQueue.publish(message as any);
    await vi.advanceTimersByTimeAsync(0);
    expect(sends).toHaveLength(1);
    const failure = expect(result).rejects.toThrow(
      "Webhook publish confirmation timed out",
    );
    await vi.advanceTimersByTimeAsync(30000);
    await failure;
  });

  it("waits for both confirmation and socket drain under backpressure", async () => {
    channel.sendToQueue.mockImplementationOnce(
      (_queue, _body, options, confirm) => {
        sends.push({ options, confirm });
        return false;
      },
    );
    const { result } = await startPublish();
    let resolved = false;
    void result.then(() => {
      resolved = true;
    });
    sends[0].confirm(null);
    await new Promise(resolve => setImmediate(resolve));
    expect(resolved).toBe(false);
    listeners.get("drain")?.();
    await expect(result).resolves.toBeUndefined();
  });

  it("removes drain listeners promptly when a backed-up publish is nacked", async () => {
    channel.sendToQueue.mockImplementationOnce(
      (_queue, _body, options, confirm) => {
        sends.push({ options, confirm });
        return false;
      },
    );
    const { result } = await startPublish();
    const drainListener = listeners.get("drain");
    expect(drainListener).toBeTypeOf("function");
    sends[0].confirm(new Error("broker nack"));
    await expect(result).rejects.toThrow("broker nack");
    expect(channel.removeListener).toHaveBeenCalledWith("drain", drainListener);
    expect(listeners.has("drain")).toBe(false);
  });
});
