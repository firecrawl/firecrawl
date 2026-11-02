import { EventEmitter } from "node:events";
import { AmqpConnection } from "../lib/amqp-connection";
import { config } from "../config";
import { logger } from "../lib/logger";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn().mockResolvedValue({ rows: [] }),
  clientConnect: vi.fn(),
}));

vi.mock("amqplib", () => ({ default: { connect: mocks.connect } }));
vi.mock("../config", () => ({
  config: {
    NUQ_RABBITMQ_URL: "amqp://test",
    INDEXER_RABBITMQ_URL: "amqp://test",
    NUQ_POD_NAME: "test",
    AMQP_SETUP_TIMEOUT_MS: 30000,
  },
}));
vi.mock("../lib/logger", () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => logger,
  };
  return { logger };
});
vi.mock("pg", () => ({
  Pool: class {
    on = vi.fn();
    query = mocks.query;
    end = vi.fn();
  },
  Client: class {
    on = vi.fn();
    connect = mocks.clientConnect;
    query = vi.fn();
    end = vi.fn().mockResolvedValue(undefined);
  },
}));
vi.mock("../services/worker/redis", () => ({ nuqRedis: {} }));
vi.mock("../lib/otel-tracer", () => ({
  withSpan: (_name: string, callback: (span: unknown) => unknown) =>
    callback({}),
  setSpanAttributes: vi.fn(),
}));

function session() {
  const channel = Object.assign(new EventEmitter(), {
    close: vi.fn(async () => {
      channel.emit("close");
    }),
    prefetch: vi.fn().mockResolvedValue(undefined),
    assertQueue: vi.fn(async (queue: string) => ({ queue })),
    assertExchange: vi.fn().mockResolvedValue(undefined),
    bindQueue: vi.fn().mockResolvedValue(undefined),
    checkQueue: vi.fn().mockResolvedValue(undefined),
    consume: vi.fn().mockResolvedValue({ consumerTag: "test" }),
    get: vi.fn().mockResolvedValue(false),
    sendToQueue: vi.fn().mockReturnValue(true),
    publish: vi.fn().mockReturnValue(true),
    ack: vi.fn(),
    nack: vi.fn(),
  });
  const connection = Object.assign(new EventEmitter(), {
    connection: { stream: { destroy: vi.fn() } },
    createChannel: vi.fn().mockResolvedValue(channel),
    close: vi.fn(async () => {
      connection.emit("close");
    }),
  });
  return { channel, connection };
}

const resources: { close(): Promise<void> }[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  mocks.connect.mockReset();
  mocks.query.mockReset().mockResolvedValue({ rows: [] });
  config.AMQP_SETUP_TIMEOUT_MS = 30000;
  vi.mocked(logger.error).mockClear();
  vi.mocked(logger.warn).mockClear();
});

afterEach(async () => {
  await Promise.all(resources.splice(0).map(resource => resource.close()));
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

function client(setup = vi.fn().mockResolvedValue(undefined)) {
  const resource = new AmqpConnection(() => "amqp://test", "test", setup);
  resources.push(resource);
  return resource;
}

test("retries failed reconnects with exponential backoff capped at 10 seconds", async () => {
  const original = session();
  const recovered = session();
  mocks.connect.mockResolvedValueOnce(original.connection);
  const resource = client();
  await resource.connect();
  mocks.connect.mockRejectedValue(new Error("ECONNREFUSED"));
  original.channel.emit("close");
  original.connection.emit("close");
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(1);
  for (const [index, delay] of [
    250, 500, 1000, 2000, 4000, 8000, 10000, 10000,
  ].entries()) {
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(mocks.connect).toHaveBeenCalledTimes(index + 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.connect).toHaveBeenCalledTimes(index + 2);
    expect(vi.getTimerCount()).toBe(1);
  }
  mocks.connect.mockResolvedValue(recovered.connection);
  await vi.advanceTimersByTimeAsync(10000);
  expect(resource.current?.channel).toBe(recovered.channel);
});

test("resets backoff after success and ignores stale close events", async () => {
  const original = session();
  const recovered = session();
  const next = session();
  mocks.connect
    .mockResolvedValueOnce(original.connection)
    .mockRejectedValueOnce(new Error("ECONNREFUSED"))
    .mockResolvedValueOnce(recovered.connection)
    .mockResolvedValueOnce(next.connection);
  const resource = client();
  await resource.connect();
  original.connection.emit("close");
  await vi.advanceTimersByTimeAsync(750);
  expect(resource.current?.channel).toBe(recovered.channel);
  original.channel.emit("close");
  expect(resource.current?.channel).toBe(recovered.channel);
  recovered.connection.emit("close");
  await vi.advanceTimersByTimeAsync(249);
  expect(mocks.connect).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1);
  expect(resource.current?.channel).toBe(next.channel);
});

test("shares startup and does not publish a session before setup succeeds", async () => {
  const opened = session();
  let finish!: () => void;
  const setup = vi.fn(
    () =>
      new Promise<void>(resolve => {
        finish = resolve;
      }),
  );
  mocks.connect.mockResolvedValue(opened.connection);
  const resource = client(setup);
  const first = resource.connect();
  const second = resource.connect();
  expect(first).toBe(second);
  await vi.advanceTimersByTimeAsync(0);
  expect(resource.current).toBeNull();
  finish();
  await first;
  expect(mocks.connect).toHaveBeenCalledTimes(1);
  expect(resource.current?.channel).toBe(opened.channel);
});

test("closes failed setup resources and retries consumer registration", async () => {
  const failed = session();
  const recovered = session();
  const setup = vi
    .fn()
    .mockRejectedValueOnce(new Error("Socket closed"))
    .mockResolvedValue(undefined);
  mocks.connect
    .mockResolvedValueOnce(failed.connection)
    .mockResolvedValue(recovered.connection);
  const resource = client(setup);
  const pending = resource.connect().catch(error => error);
  await vi.advanceTimersByTimeAsync(0);
  expect(resource.current).toBeNull();
  expect(failed.channel.close).toHaveBeenCalledTimes(1);
  expect(failed.connection.close).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(250);
  expect(await pending).toBeInstanceOf(Error);
  expect(setup).toHaveBeenCalledTimes(2);
});

test("shutdown cancels retry timers and rejects waiting callers without reconnecting", async () => {
  mocks.connect.mockRejectedValue(new Error("ECONNREFUSED"));
  const resource = client();
  const pending = resource.connect().catch(error => error);
  await vi.advanceTimersByTimeAsync(0);
  await resource.close();
  expect(await pending).toBeInstanceOf(Error);
  await vi.advanceTimersByTimeAsync(30000);
  expect(mocks.connect).toHaveBeenCalledTimes(1);
  await expect(resource.connect()).rejects.toThrow("closed");
});

test("shutdown during channel creation disposes the untracked connection", async () => {
  const opened = session();
  let finish!: (channel: typeof opened.channel) => void;
  opened.connection.createChannel.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  mocks.connect.mockResolvedValue(opened.connection);
  const resource = client();
  const pending = resource.connect().catch(error => error);
  await vi.advanceTimersByTimeAsync(0);
  const closing = resource.close();
  await closing;
  expect(opened.connection.close).toHaveBeenCalledTimes(1);
  finish(opened.channel);
  await vi.advanceTimersByTimeAsync(0);
  expect(await pending).toBeInstanceOf(Error);
  expect(opened.channel.close).toHaveBeenCalledTimes(1);
  expect(opened.connection.close).toHaveBeenCalledTimes(1);
  expect(resource.current).toBeNull();
});

test("intentional shutdown does not reopen a healthy connection", async () => {
  const opened = session();
  mocks.connect.mockResolvedValue(opened.connection);
  const resource = client();
  await resource.connect();
  await resource.close();
  opened.channel.emit("close");
  await vi.advanceTimersByTimeAsync(30000);
  expect(mocks.connect).toHaveBeenCalledTimes(1);
});

test("NuQ worker sender survives refused reconnects without rejecting its polling loop", async () => {
  const { scrapeQueue } = await import("../services/worker/nuq.js");
  resources.push({ close: () => scrapeQueue.shutdown() });
  const original = session();
  const recovered = session();
  mocks.connect
    .mockResolvedValueOnce(original.connection)
    .mockRejectedValueOnce(new Error("ECONNREFUSED"))
    .mockResolvedValue(recovered.connection);
  await scrapeQueue.getJobToProcess();
  await vi.advanceTimersByTimeAsync(0);
  original.connection.emit("close");
  mocks.query.mockClear();
  await expect(
    Promise.all([scrapeQueue.getJobToProcess(), scrapeQueue.getJobToProcess()]),
  ).resolves.toEqual([null, null]);
  expect(mocks.query).toHaveBeenCalledTimes(2);
  expect(mocks.connect).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(750);
  expect(recovered.channel.assertQueue).toHaveBeenCalledWith(
    "nuq.queue_scrape.prefetch",
    expect.any(Object),
  );
});

test("NuQ listener recovers after failed consume and recreates its exclusive consumer", async () => {
  const { scrapeQueue } = await import("../services/worker/nuq.js");
  resources.push({ close: () => scrapeQueue.shutdown() });
  const original = session();
  const failed = session();
  const recovered = session();
  failed.channel.consume.mockRejectedValueOnce(new Error("Socket closed"));
  mocks.connect
    .mockResolvedValueOnce(original.connection)
    .mockResolvedValueOnce(failed.connection)
    .mockResolvedValue(recovered.connection);
  await (scrapeQueue as any).startListener();
  original.channel.emit("close");
  await vi.advanceTimersByTimeAsync(750);
  expect(recovered.channel.consume).toHaveBeenCalledTimes(1);
  expect(failed.connection.close).toHaveBeenCalledTimes(1);
  recovered.channel.consume.mock.calls[0][1](null);
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(1);
});

test.each([403, 406, 530, "EINVAL"])(
  "propagates permanent setup error %s without retry",
  async code => {
    const opened = session();
    const error = Object.assign(new Error("bad configuration"), { code });
    mocks.connect.mockResolvedValue(opened.connection);
    const resource = client(vi.fn().mockRejectedValue(error));
    await expect(resource.connect()).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(30000);
    await expect(resource.connect()).rejects.toBe(error);
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(opened.connection.close).toHaveBeenCalledTimes(1);
  },
);

test("propagates missing URL without retry", async () => {
  const resource = new AmqpConnection(() => undefined, "test", vi.fn());
  resources.push(resource);
  await expect(resource.connect()).rejects.toThrow("not configured");
  await vi.advanceTimersByTimeAsync(30000);
  expect(mocks.connect).not.toHaveBeenCalled();
});

test("recognizes setup-time authentication failures without an error code", async () => {
  const error = new Error(
    "Handshake terminated by server: 403 (ACCESS-REFUSED)",
  );
  mocks.connect.mockRejectedValue(error);
  const resource = client();
  await expect(resource.connect()).rejects.toBe(error);
  await vi.advanceTimersByTimeAsync(30000);
  expect(mocks.connect).toHaveBeenCalledTimes(1);
});

test.each(["ENOTFOUND", "EAI_AGAIN"])(
  "retries temporary service discovery failure %s without holding startup open",
  async code => {
    const recovered = session();
    const error = Object.assign(new Error("getaddrinfo rabbitmq"), { code });
    mocks.connect
      .mockRejectedValueOnce(error)
      .mockResolvedValue(recovered.connection);
    const resource = client();
    await expect(resource.connect()).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(250);
    expect(resource.current?.channel).toBe(recovered.channel);
  },
);

test("retries broker shutdown 320 but preserves a permanent channel error during setup", async () => {
  const failed = session();
  const recovered = session();
  mocks.connect
    .mockRejectedValueOnce(
      Object.assign(new Error("broker shutdown"), { code: 320 }),
    )
    .mockResolvedValueOnce(failed.connection)
    .mockResolvedValue(recovered.connection);
  const error = Object.assign(new Error("PRECONDITION_FAILED"), { code: 406 });
  const resource = client(
    vi.fn(async () => {
      failed.channel.emit("error", error);
      failed.channel.emit("close");
    }),
  );
  await expect(resource.connect()).rejects.toMatchObject({ code: 320 });
  await vi.advanceTimersByTimeAsync(250);
  await expect(resource.connect()).rejects.toBe(error);
  await vi.advanceTimersByTimeAsync(30000);
  expect(mocks.connect).toHaveBeenCalledTimes(2);
});

test("shutdown rejects callers during stalled setup and bounds stalled teardown", async () => {
  const opened = session();
  opened.channel.close.mockImplementation(() => new Promise(() => {}));
  opened.connection.close.mockImplementation(() => new Promise(() => {}));
  mocks.connect.mockResolvedValue(opened.connection);
  const resource = client(vi.fn(() => new Promise(() => {})));
  const pending = resource.connect().catch(error => error);
  await vi.advanceTimersByTimeAsync(0);
  const closing = resource.close();
  await vi.advanceTimersByTimeAsync(999);
  expect(opened.connection.connection.stream.destroy).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await closing;
  expect(await pending).toBeInstanceOf(Error);
  expect(opened.channel.close).toHaveBeenCalledTimes(1);
  expect(opened.connection.close).toHaveBeenCalledTimes(1);
  expect(opened.connection.connection.stream.destroy).toHaveBeenCalledTimes(1);
});

test("setup timeout rejects concurrent callers and retries in the background", async () => {
  config.AMQP_SETUP_TIMEOUT_MS = 6000;
  const opened = session();
  const recovered = session();
  mocks.connect
    .mockResolvedValueOnce(opened.connection)
    .mockResolvedValue(recovered.connection);
  const resource = client(
    vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue(undefined),
  );
  const first = resource.connect().catch(error => error);
  const second = resource.connect().catch(error => error);
  await vi.advanceTimersByTimeAsync(6000);
  expect(await first).toMatchObject({ code: "ETIMEDOUT" });
  expect(await second).toMatchObject({ code: "ETIMEDOUT" });
  await vi.advanceTimersByTimeAsync(250);
  expect(resource.current?.channel).toBe(recovered.channel);
});

test("NuQ completion commits and prefetch leave PostgreSQL usable while disconnected", async () => {
  const { scrapeQueue } = await import("../services/worker/nuq.js");
  resources.push({ close: () => scrapeQueue.shutdown() });
  mocks.connect.mockImplementation(() => new Promise(() => {}));
  mocks.query.mockResolvedValue({
    rows: [{ id: "job", listen_channel_id: "listener" }],
    rowCount: 1,
  });
  await expect(scrapeQueue.jobFinish("job", "lock", {})).resolves.toBe(true);
  await expect(scrapeQueue.jobFail("job", "lock", "failed")).resolves.toBe(
    true,
  );
  mocks.query.mockClear();
  await expect(scrapeQueue.prefetchJobs()).resolves.toBe(0);
  expect(mocks.query).not.toHaveBeenCalled();
});

test("timed-out NuQ waiter never registers or checks DB after stalled startup recovers", async () => {
  const { scrapeQueue } = await import("../services/worker/nuq.js");
  resources.push({ close: () => scrapeQueue.shutdown() });
  const opened = session();
  let finish!: () => void;
  opened.channel.consume.mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        finish = resolve;
      }),
  );
  mocks.connect.mockResolvedValue(opened.connection);
  const waiting = scrapeQueue.waitForJob("job", 100).catch(error => error);
  await vi.advanceTimersByTimeAsync(100);
  expect(await waiting).toMatchObject({ message: "Timed out" });
  mocks.query.mockClear();
  finish();
  await vi.advanceTimersByTimeAsync(0);
  expect((scrapeQueue as any).listens).toEqual({});
  expect(mocks.query.mock.calls.some(([sql]) => sql.includes(".id = $1"))).toBe(
    false,
  );
});

test("NuQ waits complete through PostgreSQL during an outage and shutdown cancels waiters", async () => {
  const { scrapeQueue } = await import("../services/worker/nuq.js");
  resources.push({ close: () => scrapeQueue.shutdown() });
  mocks.connect.mockRejectedValue(new Error("ECONNREFUSED"));
  mocks.query.mockResolvedValue({ rows: [{ id: "job", status: "queued" }] });
  const waiting = scrapeQueue.waitForJob("job", 10000);
  await vi.advanceTimersByTimeAsync(0);
  mocks.query.mockResolvedValue({
    rows: [{ id: "job", status: "completed", returnvalue: "done" }],
  });
  await vi.advanceTimersByTimeAsync(500);
  await expect(waiting).resolves.toBe("done");
  mocks.query.mockResolvedValue({
    rows: [{ id: "pending", status: "queued" }],
  });
  const pending = scrapeQueue.waitForJob("pending", null).catch(error => error);
  await vi.advanceTimersByTimeAsync(0);
  await scrapeQueue.shutdown();
  expect(await pending).toMatchObject({ message: "NuQ is shutting down" });
  expect((scrapeQueue as any).listens).toEqual({});
});

test.each([
  new Error("Heartbeat timeout"),
  Object.assign(new Error("session error"), { code: 403 }),
])(
  "reconnects established sessions after %s without requiring a close event",
  async error => {
    const opened = session();
    const recovered = session();
    mocks.connect
      .mockResolvedValueOnce(opened.connection)
      .mockResolvedValue(recovered.connection);
    const resource = client();
    await resource.connect();
    opened.connection.emit("error", error);
    expect(resource.current).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith("test reconnecting", {
      error,
      retryDelayMs: 250,
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(resource.current?.channel).toBe(recovered.channel);
    expect(logger.error).not.toHaveBeenCalled();
  },
);

test("logs permanent background sender failure once and exposes it to explicit callers while PostgreSQL remains usable", async () => {
  const { scrapeQueue } = await import("../services/worker/nuq.js");
  resources.push({ close: () => scrapeQueue.shutdown() });
  const error = Object.assign(new Error("ACCESS_REFUSED"), { code: 403 });
  mocks.connect.mockRejectedValue(error);
  await expect(scrapeQueue.getJobToProcess()).resolves.toBeNull();
  await vi.advanceTimersByTimeAsync(0);
  await expect(scrapeQueue.getJobToProcess()).resolves.toBeNull();
  await expect(scrapeQueue.prefetchJobs()).rejects.toBe(error);
  await vi.advanceTimersByTimeAsync(30000);
  expect(logger.error).toHaveBeenCalledExactlyOnceWith(
    "NuQ sender setup failed permanently; recovery disabled, check configuration",
    { error },
  );
  expect(mocks.connect).toHaveBeenCalledTimes(1);
  expect(mocks.query).toHaveBeenCalledTimes(2);
});

test("slow healthy setup succeeds within the configured deadline without reconnect churn", async () => {
  config.AMQP_SETUP_TIMEOUT_MS = 45000;
  const opened = session();
  mocks.connect.mockResolvedValue(opened.connection);
  const resource = client(
    vi.fn(() => new Promise<void>(resolve => setTimeout(resolve, 35000))),
  );
  const pending = resource.connect();
  await vi.advanceTimersByTimeAsync(34999);
  expect(resource.current).toBeNull();
  expect(opened.connection.close).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await expect(pending).resolves.toMatchObject({ channel: opened.channel });
  expect(mocks.connect).toHaveBeenCalledExactlyOnceWith("amqp://test", {
    timeout: 45000,
  });
});

test.each([10000, null])(
  "healthy listener completes via DB safety poll when sender drops notification (timeout=%s)",
  async timeout => {
    const { scrapeQueue } = await import("../services/worker/nuq.js");
    resources.push({ close: () => scrapeQueue.shutdown() });
    const listening = session();
    mocks.connect
      .mockResolvedValueOnce(listening.connection)
      .mockImplementation(() => new Promise(() => {}));
    await (scrapeQueue as any).startListener();
    mocks.query.mockResolvedValue({
      rows: [{ id: "job", status: "active", listen_channel_id: "listener" }],
      rowCount: 1,
    });
    const waiting = scrapeQueue.waitForJob("job", timeout);
    await vi.advanceTimersByTimeAsync(0);
    await expect(scrapeQueue.jobFinish("job", "lock", "done")).resolves.toBe(
      true,
    );
    expect((scrapeQueue as any).amqpListener.current?.channel).toBe(
      listening.channel,
    );
    expect((scrapeQueue as any).sender).toBeNull();
    mocks.query.mockClear().mockResolvedValue({
      rows: [{ id: "job", status: "completed", returnvalue: "done" }],
    });
    await vi.advanceTimersByTimeAsync(4999);
    expect(mocks.query).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(waiting).resolves.toBe("done");
    expect((scrapeQueue as any).listens).toEqual({});
  },
);

test("failed safety poll is retried instead of rejecting the wait", async () => {
  const { scrapeQueue } = await import("../services/worker/nuq.js");
  resources.push({ close: () => scrapeQueue.shutdown() });
  const opened = session();
  mocks.connect.mockResolvedValue(opened.connection);
  mocks.query.mockResolvedValue({ rows: [{ id: "job", status: "active" }] });
  const waiting = scrapeQueue.waitForJob("job", 20000);
  await vi.advanceTimersByTimeAsync(0);
  mocks.query
    .mockReset()
    .mockRejectedValueOnce(new Error("connection terminated"))
    .mockResolvedValue({
      rows: [{ id: "job", status: "completed", returnvalue: "done" }],
    });
  await vi.advanceTimersByTimeAsync(5000);
  expect(mocks.query).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5500);
  await expect(waiting).resolves.toBe("done");
});

test("notification received before deadline allows its slow database read to finish", async () => {
  const { scrapeQueue } = await import("../services/worker/nuq.js");
  resources.push({ close: () => scrapeQueue.shutdown() });
  const opened = session();
  mocks.connect.mockResolvedValue(opened.connection);
  mocks.query.mockResolvedValue({ rows: [{ id: "job", status: "active" }] });
  const waiting = scrapeQueue.waitForJob("job", 100);
  await vi.advanceTimersByTimeAsync(50);
  let finishRead!: (result: { rows: object[] }) => void;
  mocks.query.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finishRead = resolve;
      }),
  );
  const notification = (scrapeQueue as any).listens.job[0]("completed");
  await vi.advanceTimersByTimeAsync(100);
  finishRead({
    rows: [{ id: "job", status: "completed", returnvalue: "done" }],
  });
  await notification;
  await expect(waiting).resolves.toBe("done");
});

test("extract startup propagates incompatible queue declarations", async () => {
  const extract = await import("../services/extract-queue.js");
  resources.push({ close: extract.shutdownExtractQueue });
  const opened = session();
  const error = Object.assign(new Error("PRECONDITION_FAILED"), { code: 406 });
  opened.channel.assertQueue.mockRejectedValueOnce(error);
  mocks.connect.mockResolvedValue(opened.connection);
  await expect(extract.consumeExtractJobs(vi.fn())).rejects.toBe(error);
  await vi.advanceTimersByTimeAsync(30000);
  expect(mocks.connect).toHaveBeenCalledTimes(1);
});

test("extract jobs and DLQ consumers are both restored after broker restart", async () => {
  const extract = await import("../services/extract-queue.js");
  resources.push({ close: extract.shutdownExtractQueue });
  const originals = [session(), session()];
  const recovered = [session(), session()];
  for (const opened of originals)
    mocks.connect.mockResolvedValueOnce(opened.connection);
  await Promise.all([
    extract.consumeExtractJobs(vi.fn()),
    extract.consumeExtractDLQ(vi.fn()),
  ]);
  for (const opened of recovered)
    mocks.connect.mockResolvedValueOnce(opened.connection);
  originals.forEach(opened => opened.connection.emit("close"));
  await vi.advanceTimersByTimeAsync(250);
  expect(recovered[0].channel.consume).toHaveBeenCalledWith(
    "extract.jobs",
    expect.any(Function),
    { noAck: false },
  );
  expect(recovered[1].channel.consume).toHaveBeenCalledWith(
    "extract.dlq",
    expect.any(Function),
    { noAck: false },
  );
  await extract.shutdownExtractQueue();
  await vi.advanceTimersByTimeAsync(30000);
  expect(mocks.connect).toHaveBeenCalledTimes(4);
});

test("permanent listener setup error keeps waitForJob on the PostgreSQL safety poll", async () => {
  const { scrapeQueue } = await import("../services/worker/nuq.js");
  resources.push({ close: () => scrapeQueue.shutdown() });
  mocks.connect.mockRejectedValue(
    Object.assign(new Error("ACCESS_REFUSED"), { code: 403 }),
  );
  mocks.query.mockResolvedValue({ rows: [{ id: "job", status: "active" }] });
  const waiting = scrapeQueue.waitForJob("job", 10000);
  await vi.advanceTimersByTimeAsync(0);
  mocks.query.mockResolvedValue({
    rows: [{ id: "job", status: "completed", returnvalue: "done" }],
  });
  await vi.advanceTimersByTimeAsync(500);
  await expect(waiting).resolves.toBe("done");
});

test("PostgreSQL-only listen mode surfaces listener startup failures to the waiter", async () => {
  const saved = { url: config.NUQ_RABBITMQ_URL, mode: config.NUQ_WAIT_MODE };
  config.NUQ_RABBITMQ_URL = undefined;
  config.NUQ_WAIT_MODE = "listen";
  try {
    const { scrapeQueue } = await import("../services/worker/nuq.js");
    resources.push({ close: () => scrapeQueue.shutdown() });
    const error = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    mocks.clientConnect.mockRejectedValueOnce(error);
    await expect(scrapeQueue.waitForJob("job", 10000)).rejects.toBe(error);
  } finally {
    config.NUQ_RABBITMQ_URL = saved.url;
    config.NUQ_WAIT_MODE = saved.mode;
  }
});

test("extract ack/nack on a closed channel is logged instead of escaping the consumer", async () => {
  const extract = await import("../services/extract-queue.js");
  resources.push({ close: extract.shutdownExtractQueue });
  const jobs = session();
  const dlq = session();
  mocks.connect
    .mockResolvedValueOnce(jobs.connection)
    .mockResolvedValueOnce(dlq.connection);
  const closed = () => {
    throw new Error("Channel closed");
  };
  for (const opened of [jobs, dlq]) {
    opened.channel.ack.mockImplementation(closed);
    opened.channel.nack.mockImplementation(closed);
  }
  // Job handler fails, so the catch-path nack hits the closed channel.
  await extract.consumeExtractJobs(
    vi.fn().mockRejectedValue(new Error("boom")),
  );
  // DLQ handler succeeds, so its ack hits the closed channel.
  await extract.consumeExtractDLQ(vi.fn().mockResolvedValue(undefined));
  const msg = { content: Buffer.from(JSON.stringify({ extractId: "x" })) };
  const onJob = jobs.channel.consume.mock.calls[0][1];
  const onDlq = dlq.channel.consume.mock.calls[0][1];
  await expect(onJob(msg)).resolves.toBeUndefined();
  await expect(onDlq(msg)).resolves.toBeUndefined();
  expect(jobs.channel.nack).toHaveBeenCalledWith(msg, false, false);
  expect(dlq.channel.ack).toHaveBeenCalledWith(msg);
  for (const action of ["nack", "ack"]) {
    expect(logger.warn).toHaveBeenCalledWith(
      `Could not ${action} extract message on a closed channel`,
      expect.anything(),
    );
  }
});
