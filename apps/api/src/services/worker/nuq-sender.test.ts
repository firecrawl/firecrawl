const { connect, channel, connection, logger } = vi.hoisted(() => {
  const channel = {
    assertQueue: vi.fn(async () => ({ queue: "test-listen-queue" })),
    prefetch: vi.fn(async () => {}),
    consume: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    sendToQueue: vi.fn(() => true),
    on: vi.fn(),
    close: vi.fn(async () => {}),
  };
  const connection = {
    createChannel: vi.fn(async () => channel),
    on: vi.fn(),
    close: vi.fn(async () => {}),
  };
  return {
    connect: vi.fn(),
    channel,
    connection,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

vi.mock("amqplib", () => ({ default: { connect } }));
vi.mock("pg", () => ({
  Client: class {},
  Pool: class {
    on() {}
  },
}));
vi.mock("../../config", () => ({
  config: {
    NUQ_RABBITMQ_URL: "amqp://test",
    NUQ_WAIT_MODE: "listen",
    NUQ_POD_NAME: "test-pod",
  },
}));
vi.mock("../../lib/logger", () => ({ logger }));
vi.mock("../../lib/otel-tracer", () => ({
  withSpan: vi.fn((_name, callback) => callback({})),
  setSpanAttributes: vi.fn(),
}));
vi.mock("../../lib/owner-id", () => ({ normalizeOwnerId: vi.fn() }));
vi.mock("./redis", () => ({ nuqRedis: { shutdown: vi.fn() } }));

async function sender() {
  const { scrapeQueue } = await import("./nuq");
  return scrapeQueue as any;
}

describe("NuQ RabbitMQ sender startup", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    connect.mockResolvedValue(connection);
  });

  it("waits for one shared connection before publishing concurrent completions", async () => {
    let finishConnect!: (value: typeof connection) => void;
    connect.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishConnect = resolve;
        }),
    );
    const queue = await sender();

    const first = queue.sendJobEnd("job-a", "completed", "listener-a");
    const second = queue.sendJobEnd("job-b", "failed", "listener-b");
    expect(connect).toHaveBeenCalledOnce();
    expect(channel.sendToQueue).not.toHaveBeenCalled();

    finishConnect(connection);
    await Promise.all([first, second]);
    expect(channel.sendToQueue).toHaveBeenCalledTimes(2);
    expect(
      channel.sendToQueue.mock.calls.map(call => call[1].toString()),
    ).toEqual(["completed", "failed"]);
  });

  it("allows a new attempt after a failed connection", async () => {
    connect.mockRejectedValueOnce(new Error("broker unavailable"));
    const queue = await sender();
    await expect(
      queue.sendJobEnd("job-a", "completed", "listener-a"),
    ).rejects.toThrow("broker unavailable");

    await queue.sendJobEnd("job-b", "completed", "listener-b");
    expect(connect).toHaveBeenCalledTimes(2);
    expect(channel.sendToQueue).toHaveBeenCalledOnce();
  });

  it("closes a failed channel setup and lets the next publish retry", async () => {
    channel.assertQueue.mockRejectedValueOnce(new Error("queue unavailable"));
    const queue = await sender();
    await expect(
      queue.sendJobEnd("job-a", "completed", "listener-a"),
    ).rejects.toThrow("queue unavailable");
    expect(channel.close).toHaveBeenCalledOnce();
    expect(connection.close).toHaveBeenCalledOnce();

    await queue.sendJobEnd("job-b", "completed", "listener-b");
    expect(connect).toHaveBeenCalledTimes(2);
    expect(channel.sendToQueue).toHaveBeenCalledOnce();
  });

  it("closes a connection that finishes opening after shutdown", async () => {
    let finishConnect!: (value: typeof connection) => void;
    connect.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishConnect = resolve;
        }),
    );
    const queue = await sender();
    const publishing = queue.sendJobEnd("job-a", "completed", "listener-a");
    await queue.shutdown();

    finishConnect(connection);
    await publishing;
    expect(connection.close).toHaveBeenCalledOnce();
    expect(channel.sendToQueue).not.toHaveBeenCalled();
  });
});

describe("NuQ listener recovery scan", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    connect.mockResolvedValue(connection);
  });

  it("handles a failed recovery query without an unhandled rejection", async () => {
    const queue = await sender();
    const failure = new Error("database unavailable");
    queue.getJobs = vi.fn().mockRejectedValue(failure);

    await queue.startListener();

    await vi.waitFor(() =>
      expect(logger.warn).toHaveBeenCalledWith(
        "NuQ listener recovery scan failed",
        { error: failure, module: "nuq" },
      ),
    );
  });

  it("ignores a listener removed while the recovery query was pending", async () => {
    const queue = await sender();
    queue.listens["job-a"] = [vi.fn()];
    queue.getJobs = vi.fn(async () => {
      delete queue.listens["job-a"];
      return [{ id: "job-a", status: "completed" }];
    });

    await queue.startListener();
    await vi.waitFor(() => expect(queue.getJobs).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
