import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// A minimal in-memory stand-in for one RabbitMQ channel holding one queue with
// prefetch 1 semantics: a consumer gets at most one unacked delivery.
const { broker, connect, pgQuery } = vi.hoisted(() => {
  const { EventEmitter } = require("events") as typeof import("events");

  class FakeChannel extends EventEmitter {
    calls: string[] = [];
    ready: any[] = [];
    consumers = new Map<string, (msg: any) => void>();
    unackedByTag = new Map<string, any>();
    ghost = false; // consumers register but never receive (lost subscription)
    failConsume = false;
    private nextTag = 0;

    async assertQueue() {
      this.calls.push("assertQueue");
      return {};
    }
    async prefetch() {
      this.calls.push("prefetch");
    }
    async consume(_queue: string, cb: (msg: any) => void) {
      this.calls.push("consume");
      if (this.failConsume) throw new Error("consume refused");
      const tag = `ctag-${++this.nextTag}`;
      this.consumers.set(tag, cb);
      queueMicrotask(() => this.deliver());
      return { consumerTag: tag };
    }
    async cancel(tag: string) {
      this.calls.push("cancel");
      this.consumers.delete(tag);
    }
    ack(msg: any) {
      this.calls.push("ack");
      for (const [tag, m] of this.unackedByTag)
        if (m === msg) this.unackedByTag.delete(tag);
    }
    nack(msg: any, _allUpTo: boolean, requeue: boolean) {
      this.calls.push("nack");
      for (const [tag, m] of this.unackedByTag)
        if (m === msg) this.unackedByTag.delete(tag);
      if (requeue) this.ready.unshift(msg);
    }
    async get() {
      this.calls.push("get");
      return this.ready.shift() ?? false;
    }
    async checkQueue() {
      this.calls.push("checkQueue");
      return { messageCount: this.ready.length };
    }
    publish(job: { id: string }) {
      this.ready.push({
        content: Buffer.from(
          JSON.stringify({ ...job, createdAt: new Date().toISOString() }),
        ),
      });
      this.deliver();
    }
    deliver() {
      if (this.ghost) return;
      for (const [tag, cb] of this.consumers) {
        if (this.ready.length === 0) return;
        if (this.unackedByTag.has(tag)) continue;
        const msg = this.ready.shift();
        this.unackedByTag.set(tag, msg);
        cb(msg);
      }
    }
  }

  const broker = { channel: null as any, connection: null as any };
  const connect = vi.fn(async () => {
    broker.channel = new FakeChannel();
    broker.connection = Object.assign(new EventEmitter(), {
      createChannel: vi.fn(async () => broker.channel),
      close: vi.fn(async () => {}),
    });
    return broker.connection;
  });
  const pgQuery = vi.fn(async () => ({ rows: [] }));
  return { broker, connect, pgQuery };
});

vi.mock("amqplib", () => ({ default: { connect } }));
vi.mock("pg", () => ({
  Pool: class {
    query = pgQuery;
    on() {}
  },
  Client: class {},
}));
vi.mock("./redis", () => ({ nuqRedis: {} }));
vi.mock("../../config", () => ({
  config: { NUQ_RABBITMQ_URL: "amqp://rabbitmq", NUQ_POD_NAME: "test" },
}));
vi.mock("../../lib/logger", () => {
  const logger: any = {
    child: vi.fn(() => logger),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return { logger };
});
vi.mock("../../lib/otel-tracer", () => ({
  withSpan: vi.fn(async (_name: string, fn: (span: any) => any) => fn({})),
  setSpanAttributes: vi.fn(),
}));

async function freshQueue() {
  vi.resetModules();
  const { scrapeQueue } = await import("./nuq.js");
  return scrapeQueue;
}

// Runs one getJobToProcess() call to completion under fake timers.
async function take(queue: Awaited<ReturnType<typeof freshQueue>>) {
  const pending = queue.getJobToProcess();
  await vi.advanceTimersByTimeAsync(5_000);
  return pending;
}

describe("NuQ prefetch take (RabbitMQ)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    connect.mockClear();
    pgQuery.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("an idle worker subscribes once and does not poll the queue", async () => {
    const queue = await freshQueue();
    for (let i = 0; i < 5; i++) expect(await take(queue)).toBeNull();

    const calls = broker.channel.calls as string[];
    expect(calls.filter(c => c === "get")).toHaveLength(0);
    expect(calls.filter(c => c === "consume")).toHaveLength(1);
    expect(broker.channel.consumers.size).toBe(1);
  });

  test("a pushed job is taken, and the busy worker holds no subscription", async () => {
    const queue = await freshQueue();
    expect(await take(queue)).toBeNull(); // subscribe while idle

    const pending = queue.getJobToProcess();
    await vi.advanceTimersByTimeAsync(100);
    broker.channel.publish({ id: "job-1" });
    await vi.advanceTimersByTimeAsync(100);
    const job = await pending;

    expect(job?.id).toBe("job-1");
    const calls = broker.channel.calls as string[];
    // cancel first, then ack: no second job can be pushed to a busy worker
    expect(calls.lastIndexOf("cancel")).toBeLessThan(calls.lastIndexOf("ack"));
    expect(broker.channel.consumers.size).toBe(0);
    expect(broker.channel.unackedByTag.size).toBe(0);

    broker.channel.publish({ id: "job-2" });
    expect(broker.channel.ready).toHaveLength(1); // waits for the next idle call
    expect((await take(queue))?.id).toBe("job-2");
  });

  test("resubscribes when ready messages are not delivered to an idle subscriber", async () => {
    const queue = await freshQueue();
    expect(await take(queue)).toBeNull();

    broker.channel.ghost = true; // subscription silently lost
    broker.channel.publish({ id: "job-stuck" });
    expect(await take(queue)).toBeNull();
    expect(await take(queue)).toBeNull(); // second sighting drops the subscription
    expect(broker.channel.consumers.size).toBe(0);

    broker.channel.ghost = false;
    expect((await take(queue))?.id).toBe("job-stuck");
    expect(
      (broker.channel.calls as string[]).filter(c => c === "consume"),
    ).toHaveLength(2);
  });

  test("falls back to postgres and closes the sender when subscribing fails", async () => {
    const queue = await freshQueue();
    await vi.advanceTimersByTimeAsync(0);
    const pending = queue.getJobToProcess();
    // fail the subscription on the channel that the call is about to use
    await vi.waitFor(() => expect(broker.channel).toBeTruthy());
    broker.channel.failConsume = true;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await pending).toBeNull();
    expect(pgQuery).toHaveBeenCalledTimes(1);
    expect(broker.connection.close).toHaveBeenCalled();
  });
});
