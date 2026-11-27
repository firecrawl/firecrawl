import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConsumeMessage } from "amqplib";
import type { crawlFinishedQueue, nuqShutdown } from "./nuq.js";

const { connect } = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("amqplib", () => ({ default: { connect } }));
vi.mock("./redis", () => ({ nuqRedis: { shutdown: async () => {} } }));
vi.setConfig({ testTimeout: 5000 });

type Delivery = (message: ConsumeMessage | null) => void;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const activeJob = {
  id: "job",
  status: "active" as const,
  createdAt: new Date(),
  priority: 0,
  data: {},
};
const completedJob = {
  ...activeJob,
  status: "completed" as const,
  returnvalue: { ok: true },
};

function completion(): ConsumeMessage {
  return {
    fields: {
      deliveryTag: 1,
      redelivered: false,
      exchange: "",
      routingKey: "queue",
      consumerTag: "tag",
    },
    properties: {
      correlationId: activeJob.id,
      contentType: undefined,
      contentEncoding: undefined,
      headers: undefined,
      deliveryMode: undefined,
      priority: undefined,
      replyTo: undefined,
      expiration: undefined,
      messageId: undefined,
      timestamp: undefined,
      type: undefined,
      userId: undefined,
      appId: undefined,
      clusterId: undefined,
    },
    content: Buffer.from("completed"),
  };
}

function broker() {
  const channel = Object.assign(new EventEmitter(), {
    prefetch: vi.fn().mockResolvedValue(undefined),
    assertQueue: vi.fn().mockResolvedValue({ queue: "queue" }),
    consume: vi
      .fn<
        (
          queue: string,
          deliver: Delivery,
        ) => Promise<{
          consumerTag: string;
        }>
      >()
      .mockResolvedValue({ consumerTag: "tag" }),
    ack: vi.fn(),
    cancel: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  });
  const connection = Object.assign(new EventEmitter(), {
    createChannel: vi.fn().mockResolvedValue(channel),
    close: vi.fn().mockResolvedValue(undefined),
  });
  return { channel, connection };
}

describe("NuQ RabbitMQ listener", () => {
  let nuq: {
    crawlFinishedQueue: typeof crawlFinishedQueue;
    nuqShutdown: typeof nuqShutdown;
  };

  beforeEach(async () => {
    vi.stubEnv("NUQ_RABBITMQ_URL", "amqp://localhost");
    vi.resetModules();
    connect.mockReset();
    nuq = await import("./nuq.js");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    await nuq?.nuqShutdown();
  });

  it("releases a failed subscription and receives the next job completion", async () => {
    const failed = broker();
    const recovered = broker();
    const failure = new Error("consume failed");
    failed.channel.consume.mockRejectedValueOnce(failure);
    connect
      .mockResolvedValueOnce(failed.connection)
      .mockResolvedValueOnce(recovered.connection);

    const { crawlFinishedQueue: queue } = nuq;
    const getJob = vi.spyOn(queue, "getJob").mockResolvedValue(activeJob);

    await expect(queue.waitForJob("first", null)).rejects.toBe(failure);
    expect(failed.channel.close).toHaveBeenCalledOnce();
    expect(failed.connection.close).toHaveBeenCalledOnce();
    expect(getJob).not.toHaveBeenCalled();

    const result = queue.waitForJob(activeJob.id, 2000);
    const received = expect(result).resolves.toEqual(completedJob.returnvalue);
    await vi.waitFor(() =>
      expect(getJob).toHaveBeenCalledWith(activeJob.id, expect.anything()),
    );
    getJob.mockResolvedValue(completedJob);
    const message = completion();
    const deliver = recovered.channel.consume.mock.calls[0][1];
    const invalid = { ...message, content: Buffer.from("active") };
    deliver(invalid);
    expect(recovered.channel.ack).toHaveBeenCalledWith(invalid);
    expect(getJob).toHaveBeenCalledTimes(1);
    deliver(message);

    await received;
    expect(recovered.channel.ack).toHaveBeenCalledWith(message);
    expect(connect).toHaveBeenCalledTimes(2);
    await queue.shutdown();
    expect(recovered.channel.cancel).toHaveBeenCalledWith("tag");
  });

  it("shares a pending consume and reports its failure to every waiter", async () => {
    const attempt = broker();
    const entered = deferred<void>();
    const subscribed = deferred<{ consumerTag: string }>();
    const failure = new Error("consume failed");
    const { crawlFinishedQueue: queue } = nuq;
    const getJob = vi.spyOn(queue, "getJob").mockResolvedValue(activeJob);
    attempt.channel.consume.mockImplementation(() => {
      entered.resolve();
      return subscribed.promise;
    });
    attempt.channel.close.mockRejectedValueOnce(new Error("Channel closed"));
    connect.mockResolvedValueOnce(attempt.connection);

    const first = expect(queue.waitForJob("first", null)).rejects.toBe(failure);
    await entered.promise;
    const second = expect(queue.waitForJob("second", null)).rejects.toBe(
      failure,
    );
    subscribed.reject(failure);
    await Promise.all([first, second]);
    expect(getJob).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledOnce();
    expect(attempt.connection.close).toHaveBeenCalledOnce();
  });

  it("closes the connection when setup fails before a channel exists", async () => {
    const attempt = broker();
    const failure = new Error("createChannel failed");
    attempt.connection.createChannel.mockRejectedValueOnce(failure);
    connect.mockResolvedValueOnce(attempt.connection);

    await expect(
      nuq.crawlFinishedQueue.waitForJob(activeJob.id, null),
    ).rejects.toBe(failure);
    expect(attempt.connection.close).toHaveBeenCalledOnce();
    expect(attempt.channel.consume).not.toHaveBeenCalled();
  });

  it("does not publish a channel that closes before consume resumes", async () => {
    const attempt = broker();
    const { crawlFinishedQueue: queue } = nuq;
    attempt.channel.consume.mockImplementation(async () => {
      attempt.channel.emit("close");
      return { consumerTag: "closed" };
    });
    connect.mockResolvedValueOnce(attempt.connection);

    await expect(queue.waitForJob(activeJob.id, null)).rejects.toThrow(
      "NuQ listener closed during startup",
    );
    expect(attempt.channel.close).toHaveBeenCalledOnce();
    expect(attempt.connection.close).toHaveBeenCalledOnce();
  });

  it("backs off after repeated reconnect failures and reconciles missed completions", async () => {
    const original = broker();
    const failed = broker();
    const recovered = broker();
    failed.channel.consume.mockRejectedValueOnce(new Error("consume failed"));
    connect
      .mockResolvedValueOnce(original.connection)
      .mockRejectedValueOnce(new Error("broker unavailable"))
      .mockResolvedValueOnce(failed.connection)
      .mockResolvedValueOnce(recovered.connection);
    const { crawlFinishedQueue: queue } = nuq;
    const waiting = deferred<void>();
    const getJob = vi
      .spyOn(queue, "getJob")
      .mockImplementationOnce(async () => {
        waiting.resolve();
        return activeJob;
      });
    const getJobs = vi.spyOn(queue, "getJobs").mockResolvedValueOnce([]);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const result = queue.waitForJob(activeJob.id, 2000);
    const received = expect(result).resolves.toEqual(completedJob.returnvalue);
    await waiting.promise;

    getJob.mockResolvedValue(completedJob);
    getJobs.mockResolvedValue([completedJob]);
    const early = completion();
    recovered.channel.consume.mockImplementation(async (_queue, deliver) => {
      deliver({
        ...early,
        properties: { ...early.properties, correlationId: "unrelated" },
      });
      return { consumerTag: "recovered" };
    });
    original.channel.consume.mock.calls[0][1](null);
    await vi.advanceTimersByTimeAsync(250);
    expect(connect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(499);
    expect(connect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(connect).toHaveBeenCalledTimes(3);
    expect(failed.channel.close).toHaveBeenCalledOnce();
    expect(failed.connection.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(999);
    expect(connect).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);

    await received;
    original.channel.emit("close");
    original.connection.emit("close");
    await vi.advanceTimersByTimeAsync(250);
    expect(original.connection.close).toHaveBeenCalledOnce();
    expect(getJobs).toHaveBeenCalledWith([activeJob.id]);
    expect(recovered.channel.ack).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledTimes(4);
    await queue.shutdown();
    expect(recovered.channel.cancel).toHaveBeenCalledWith("recovered");
  });

  it("cleans up rather than publishing a subscription that completes during shutdown", async () => {
    const attempt = broker();
    const waiting = deferred<void>();
    const subscribed = deferred<{ consumerTag: string }>();
    attempt.channel.consume.mockImplementation(() => {
      waiting.resolve();
      return subscribed.promise;
    });
    connect.mockResolvedValueOnce(attempt.connection);
    const { crawlFinishedQueue: queue } = nuq;

    const result = expect(queue.waitForJob(activeJob.id, null)).rejects.toThrow(
      "NuQ listener is shutting down",
    );
    await waiting.promise;
    let didShutdown = false;
    const shutdown = queue.shutdown().then(() => {
      didShutdown = true;
    });
    await Promise.resolve();
    const shutDownDuringStartup = didShutdown;
    subscribed.resolve({ consumerTag: "tag" });

    await shutdown;
    expect(shutDownDuringStartup).toBe(false);
    expect(attempt.channel.close).toHaveBeenCalledOnce();
    expect(attempt.connection.close).toHaveBeenCalledOnce();
    await result;
  });

  it("bounds shutdown while closing a disconnected listener", async () => {
    const attempt = broker();
    const closing = deferred<void>();
    const { crawlFinishedQueue: queue } = nuq;
    connect.mockResolvedValueOnce(attempt.connection);
    attempt.connection.close.mockReturnValueOnce(closing.promise);
    vi.spyOn(queue, "getJob").mockResolvedValue(completedJob);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await queue.waitForJob(activeJob.id, null);
    attempt.channel.consume.mock.calls[0][1](null);

    let didShutdown = false;
    const shutdown = queue.shutdown().then(() => {
      didShutdown = true;
    });
    await vi.advanceTimersByTimeAsync(4999);
    expect(didShutdown).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await shutdown;

    closing.resolve();
    await vi.advanceTimersByTimeAsync(5000);
    expect(connect).toHaveBeenCalledOnce();
  });

  it("closes a connection that arrives after the shutdown deadline without starting a subscription", async () => {
    const attempt = broker();
    const connecting = deferred<typeof attempt.connection>();
    const { crawlFinishedQueue: queue } = nuq;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    connect.mockReturnValueOnce(connecting.promise);
    const result = expect(queue.waitForJob(activeJob.id, null)).rejects.toThrow(
      "NuQ listener is shutting down",
    );
    expect(connect).toHaveBeenCalledOnce();

    const shutdown = queue.shutdown();
    await vi.advanceTimersByTimeAsync(5000);
    await shutdown;
    connecting.resolve(attempt.connection);

    await result;
    expect(attempt.connection.createChannel).not.toHaveBeenCalled();
    expect(attempt.connection.close).toHaveBeenCalledOnce();
  });

  it("cancels a scheduled reconnect when the queue shuts down", async () => {
    const attempt = broker();
    const { crawlFinishedQueue: queue } = nuq;
    connect
      .mockResolvedValueOnce(attempt.connection)
      .mockRejectedValueOnce(new Error("broker unavailable"));
    vi.spyOn(queue, "getJob").mockResolvedValue(completedJob);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await queue.waitForJob(activeJob.id, null);
    attempt.channel.consume.mock.calls[0][1](null);
    await vi.advanceTimersByTimeAsync(250);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);

    await queue.shutdown();

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("does not register a waiter that timed out during startup", async () => {
    const attempt = broker();
    const entered = deferred<void>();
    const subscribed = deferred<{ consumerTag: string }>();
    attempt.channel.consume.mockImplementation(() => {
      entered.resolve();
      return subscribed.promise;
    });
    connect.mockResolvedValueOnce(attempt.connection);
    const { crawlFinishedQueue: queue } = nuq;
    const getJob = vi.spyOn(queue, "getJob").mockResolvedValue(completedJob);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const timedOut = expect(
      queue.waitForJob(activeJob.id, 100),
    ).rejects.toThrow("Timed out");
    await entered.promise;
    await vi.advanceTimersByTimeAsync(100);
    await timedOut;

    const live = queue.waitForJob("live", 1000);
    subscribed.resolve({ consumerTag: "tag" });
    await expect(live).resolves.toEqual(completedJob.returnvalue);
    attempt.channel.consume.mock.calls[0][1](completion());
    expect(getJob.mock.calls.map(([id]) => id)).toEqual(["live"]);
  });
});
