import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  sendToQueue: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("pg", () => ({
  Pool: class {
    query = mocks.query;
    on() {}
  },
  Client: class {},
}));
vi.mock("../../config", () => ({
  config: { NUQ_POD_NAME: "test", NUQ_RABBITMQ_URL: "amqp://test.invalid" },
}));
vi.mock("../../lib/logger", () => {
  const logger = {
    info: vi.fn(),
    warn: mocks.warn,
    error: vi.fn(),
    child: () => logger,
  };
  return { logger };
});
vi.mock("../../lib/otel-tracer", () => ({}));
vi.mock("./redis", () => ({ nuqRedis: {} }));
vi.mock("amqplib", () => ({
  default: {
    connect: async () => ({
      on() {},
      createChannel: async () => ({
        assertQueue: async () => {},
        on() {},
        sendToQueue: mocks.sendToQueue,
      }),
    }),
  },
}));

import { scrapeQueue } from "./nuq";

const dnsError = (code = "ENOTFOUND") =>
  Object.assign(new Error(code), { code, syscall: "getaddrinfo" });
const rows = [
  {
    id: "job-1",
    status: "active",
    created_at: new Date(0),
    priority: 0,
    data: {},
  },
];

describe("NuQ prefetch name-resolution failures", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    mocks.query.mockReset();
    mocks.sendToQueue.mockReset();
    mocks.warn.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("retries DNS failures before claiming and publishes the claimed job once", async () => {
    mocks.query
      .mockRejectedValueOnce(dnsError())
      .mockRejectedValueOnce(dnsError("EAI_AGAIN"))
      .mockResolvedValue({ rows });
    const result = scrapeQueue.prefetchJobs().then(
      value => ({ value }),
      error => ({ error }),
    );
    await vi.advanceTimersByTimeAsync(999);
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.sendToQueue).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.query).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(mocks.query).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual({ value: 1 });
    expect(mocks.query).toHaveBeenCalledTimes(3);
    expect(mocks.sendToQueue).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mocks.sendToQueue.mock.calls[0][1].toString()).id).toBe(
      "job-1",
    );
  });

  it("stops after five attempts and preserves the final error", async () => {
    const error = dnsError();
    const attempts: number[] = [];
    mocks.query.mockImplementation(() => {
      attempts.push(Date.now());
      return Promise.reject(error);
    });
    const result = expect(scrapeQueue.prefetchJobs()).rejects.toBe(error);
    await vi.runAllTimersAsync();
    await result;
    expect(mocks.query).toHaveBeenCalledTimes(5);
    expect(attempts).toEqual([0, 1000, 3000, 7000, 15000]);
    expect(mocks.warn).toHaveBeenCalledTimes(4);
    expect(mocks.sendToQueue).not.toHaveBeenCalled();
  });

  it.each([
    { code: "ECONNRESET", syscall: "read" },
    { code: "ECONNREFUSED", syscall: "connect" },
    { code: "ETIMEDOUT", syscall: "connect" },
    { code: "28P01" },
    { code: "42601" },
    { code: "ENOTFOUND", syscall: "query" },
  ])(
    "does not retry an ambiguous connection or SQL failure: %j",
    async details => {
      const error = Object.assign(new Error("query failed"), details);
      mocks.query.mockRejectedValue(error);
      await expect(scrapeQueue.prefetchJobs()).rejects.toBe(error);
      expect(mocks.query).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(mocks.sendToQueue).not.toHaveBeenCalled();
    },
  );

  it("never replays a successful claim when publishing fails with a DNS-shaped error", async () => {
    const error = dnsError();
    mocks.query.mockResolvedValue({ rows });
    mocks.sendToQueue.mockImplementation(() => {
      throw error;
    });
    await expect(scrapeQueue.prefetchJobs()).rejects.toBe(error);
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.sendToQueue).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts a new retry budget for each prefetch call", async () => {
    for (let call = 0; call < 2; call++) {
      mocks.query
        .mockRejectedValueOnce(dnsError())
        .mockResolvedValueOnce({ rows: [] });
      const result = scrapeQueue.prefetchJobs().then(
        value => ({ value }),
        error => ({ error }),
      );
      await vi.runAllTimersAsync();
      expect(await result).toEqual({ value: 0 });
    }
    expect(mocks.query).toHaveBeenCalledTimes(4);
    expect(mocks.sendToQueue).not.toHaveBeenCalled();
  });
});
