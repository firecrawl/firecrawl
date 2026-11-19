const { connect, channel, connection, logger, poolQuery } = vi.hoisted(() => {
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
    poolQuery: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

vi.mock("amqplib", () => ({ default: { connect } }));
vi.mock("pg", () => ({
  Client: class {},
  Pool: class {
    on() {}
    query(...args: any[]) {
      return poolQuery(...args);
    }
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
    connect.mockReset();
    connection.createChannel.mockReset();
    channel.assertQueue.mockReset();
    connect.mockResolvedValue(connection);
    connection.createChannel.mockResolvedValue(channel);
    channel.assertQueue.mockResolvedValue({ queue: "test-listen-queue" });
    poolQuery.mockResolvedValue({ rows: [] });
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

  it("waits for one shared connection before sending concurrent prefetch hints", async () => {
    let finishConnect!: (value: typeof connection) => void;
    connect.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishConnect = resolve;
        }),
    );
    const queue = await sender();
    const first = queue.sendJobPrefetch({ id: "job-a" }, logger);
    const second = queue.sendJobPrefetch({ id: "job-b" }, logger);
    expect(channel.sendToQueue).not.toHaveBeenCalled();

    finishConnect(connection);
    await Promise.all([first, second]);
    expect(connect).toHaveBeenCalledOnce();
    expect(channel.sendToQueue).toHaveBeenCalledTimes(2);
    expect(channel.sendToQueue.mock.calls.map(call => call[0])).toEqual([
      "nuq.queue_scrape.prefetch",
      "nuq.queue_scrape.prefetch",
    ]);
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

  it("falls back to Postgres when the sender connection fails", async () => {
    const failure = new Error("broker unavailable");
    connect.mockRejectedValueOnce(failure);
    const queue = await sender();

    await expect(queue.getJobToProcess()).resolves.toBeNull();
    expect(poolQuery).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      "NuQ sender unavailable, falling back to postgres",
      { module: "nuq/rabbitmq", err: failure },
    );
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("ignores late close events from a replaced sender", async () => {
    const makePair = () => {
      const ch = {
        ...channel,
        on: vi.fn(),
        sendToQueue: vi.fn(() => true),
      };
      const conn = {
        ...connection,
        on: vi.fn(),
        createChannel: vi.fn(async () => ch),
      };
      return { ch, conn };
    };
    const old = makePair();
    const current = makePair();
    connect.mockResolvedValueOnce(old.conn).mockResolvedValueOnce(current.conn);
    const queue = await sender();
    await queue.sendJobEnd("job-a", "completed", "listener-a");

    const oldChannelClose = old.ch.on.mock.calls.find(
      call => call[0] === "close",
    )![1];
    const oldConnectionClose = old.conn.on.mock.calls.find(
      call => call[0] === "close",
    )![1];
    oldChannelClose();
    await queue.sendJobEnd("job-b", "completed", "listener-b");
    oldChannelClose();
    oldConnectionClose();
    await queue.sendJobEnd("job-c", "completed", "listener-c");

    expect(connect).toHaveBeenCalledTimes(2);
    expect(current.ch.sendToQueue).toHaveBeenCalledTimes(2);
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

  it("skips queue setup when shutdown finishes during channel creation", async () => {
    let finishChannel!: (value: typeof channel) => void;
    connection.createChannel.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishChannel = resolve;
        }),
    );
    const queue = await sender();
    const publishing = queue.sendJobEnd("job-a", "completed", "listener-a");
    await vi.waitFor(() =>
      expect(connection.createChannel).toHaveBeenCalledOnce(),
    );
    await queue.shutdown();

    finishChannel(channel);
    await publishing;
    expect(channel.assertQueue).not.toHaveBeenCalled();
    expect(channel.close).toHaveBeenCalledOnce();
    expect(connection.close).toHaveBeenCalledOnce();
    expect(channel.sendToQueue).not.toHaveBeenCalled();
  });
});

describe("NuQ listener recovery scan", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    connect.mockReset();
    connection.createChannel.mockReset();
    channel.assertQueue.mockReset();
    connect.mockResolvedValue(connection);
    connection.createChannel.mockResolvedValue(channel);
    channel.assertQueue.mockResolvedValue({ queue: "test-listen-queue" });
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
