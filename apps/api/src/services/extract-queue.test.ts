import type { Mock } from "vitest";

const { connectMock, channelMock, connectionMock, loggerMock } = vi.hoisted(
  () => {
    const channelMock = {
      assertExchange: vi.fn(),
      assertQueue: vi.fn(),
      bindQueue: vi.fn(),
      sendToQueue: vi.fn(() => true),
      on: vi.fn(),
      prefetch: vi.fn(),
      consume: vi.fn(),
    };
    const connectionMock = {
      createConfirmChannel: vi.fn(() => channelMock),
      on: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const connectMock = vi.fn(() => connectionMock);
    const loggerMock = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    return { connectMock, channelMock, connectionMock, loggerMock };
  },
);

vi.mock("amqplib", () => ({ default: { connect: connectMock } }));
vi.mock("../config", () => ({
  config: { NUQ_RABBITMQ_URL: "amqp://test" },
}));
vi.mock("../lib/logger", () => ({ logger: loggerMock }));

const job = {
  extractId: "extract-1",
  request: { urls: ["https://example.com"] },
  teamId: "team-1",
  createdAt: 1,
};

function callback(): (error: Error | null) => void {
  return (channelMock.sendToQueue as Mock).mock.calls.at(-1)?.[3];
}

function channelEvent(name: string): (...args: any[]) => void {
  const call = (channelMock.on as Mock).mock.calls.find(c => c[0] === name);
  if (!call) throw new Error(`Missing ${name} listener`);
  return call[1];
}

function connectionEvent(name: string): (...args: any[]) => void {
  const call = (connectionMock.on as Mock).mock.calls.find(c => c[0] === name);
  if (!call) throw new Error(`Missing ${name} listener`);
  return call[1];
}

describe("extract job publishing", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    channelMock.sendToQueue.mockReturnValue(true);
  });

  afterEach(() => vi.useRealTimers());

  it("waits for a broker confirmation before reporting success", async () => {
    const { addExtractJob } = await import("./extract-queue.js");
    let settled = false;
    const publish = addExtractJob(job.extractId, job).then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(channelMock.sendToQueue).toHaveBeenCalled());

    const [queue, body, options] = (channelMock.sendToQueue as Mock).mock
      .calls[0];
    expect(queue).toBe("extract.jobs");
    expect(JSON.parse(body.toString())).toEqual(job);
    expect(options).toMatchObject({
      persistent: true,
      mandatory: true,
      messageId: job.extractId,
    });
    expect(settled).toBe(false);

    callback()(null);
    await publish;
    expect(settled).toBe(true);
  });

  it("rejects a broker nack instead of claiming the job was enqueued", async () => {
    const { addExtractJob } = await import("./extract-queue.js");
    const publish = addExtractJob(job.extractId, job);
    const failure = expect(publish).rejects.toThrow("broker rejected");
    await vi.waitFor(() => expect(channelMock.sendToQueue).toHaveBeenCalled());
    callback()(new Error("broker rejected"));
    await failure;
    expect(loggerMock.info).not.toHaveBeenCalledWith(
      "Extract job added to queue",
      expect.anything(),
    );
  });

  it("rejects a returned unroutable message despite a broker ack", async () => {
    const { addExtractJob } = await import("./extract-queue.js");
    const publish = addExtractJob(job.extractId, job);
    const failure = expect(publish).rejects.toThrow("unroutable extract job");
    await vi.waitFor(() => expect(channelMock.sendToQueue).toHaveBeenCalled());
    const options = (channelMock.sendToQueue as Mock).mock.calls[0][2];
    channelEvent("return")({
      properties: { correlationId: options.correlationId },
    });
    callback()(null);
    await failure;
  });

  it("treats a full client buffer as backpressure and still waits for the ack", async () => {
    channelMock.sendToQueue.mockReturnValue(false);
    const { addExtractJob } = await import("./extract-queue.js");
    const publish = addExtractJob(job.extractId, job);
    await vi.waitFor(() => expect(channelMock.sendToQueue).toHaveBeenCalled());
    expect(loggerMock.warn).toHaveBeenCalledWith(
      "Extract job publish buffer full",
      { extractId: job.extractId },
    );
    callback()(null);
    await publish;
  });

  it("rejects a publish with no broker confirmation after a bounded wait", async () => {
    const { addExtractJob } = await import("./extract-queue.js");
    vi.useFakeTimers();
    const publish = addExtractJob(job.extractId, job);
    const failure = expect(publish).rejects.toThrow("confirmation timed out");
    await vi.waitFor(() => expect(channelMock.sendToQueue).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(10_000);
    await failure;
  });

  it("rejects pending publishes immediately when the connection closes", async () => {
    const { addExtractJob } = await import("./extract-queue.js");
    const publish = addExtractJob(job.extractId, job);
    const failure = expect(publish).rejects.toThrow("connection closed");
    await vi.waitFor(() => expect(channelMock.sendToQueue).toHaveBeenCalled());
    connectionEvent("close")();
    await failure;
  });

  it("discards a closed channel and rejects its pending publish", async () => {
    const { addExtractJob } = await import("./extract-queue.js");
    const publish = addExtractJob(job.extractId, job);
    const failure = expect(publish).rejects.toThrow("channel closed");
    await vi.waitFor(() => expect(channelMock.sendToQueue).toHaveBeenCalled());
    channelEvent("close")();
    await failure;
    expect(connectionMock.close).toHaveBeenCalledOnce();
  });

  it("shares one confirm channel across concurrent publishers", async () => {
    const { addExtractJob } = await import("./extract-queue.js");
    const first = addExtractJob("extract-1", job);
    const second = addExtractJob("extract-2", {
      ...job,
      extractId: "extract-2",
    });
    await vi.waitFor(() =>
      expect(channelMock.sendToQueue).toHaveBeenCalledTimes(2),
    );
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(connectionMock.createConfirmChannel).toHaveBeenCalledTimes(1);

    for (const call of (channelMock.sendToQueue as Mock).mock.calls)
      call[3](null);
    await Promise.all([first, second]);
  });
});
