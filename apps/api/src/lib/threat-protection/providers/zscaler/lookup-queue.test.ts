import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  queue: [] as string[],
  replies: new Map<string, string>(),
  llen: vi.fn(),
  rpush: vi.fn(),
  lpop: vi.fn(),
  get: vi.fn(),
  del: vi.fn(),
  acquire: vi.fn(),
  extend: vi.fn(),
  release: vi.fn(),
  lookup: vi.fn(),
  exec: vi.fn(),
}));
vi.mock("../../../../services/rate-limiter", () => ({
  redisRateLimitClient: {
    llen: mock.llen,
    rpush: mock.rpush,
    lpop: mock.lpop,
    get: mock.get,
    del: mock.del,
    pipeline: () => {
      const pending: [string, string][] = [];
      const pipeline = {
        set: (key: string, value: string) => {
          pending.push([key, value]);
          return pipeline;
        },
        exec: async () => {
          const failure = await mock.exec();
          if (failure) return failure;
          pending.forEach(([key, value]) => mock.replies.set(key, value));
          return pending.map(() => [null, "OK"]);
        },
      };
      return pipeline;
    },
  },
}));
vi.mock("../../../../services/redlock", () => ({
  redlock: { acquire: mock.acquire },
}));
vi.mock("../../../logger", () => ({
  logger: { child: () => ({ warn: vi.fn() }) },
}));
vi.mock("../../store", () => ({
  getOrgZscalerCredentials: async () => ({ vanityDomain: "tenant" }),
}));
vi.mock("rate-limiter-flexible", () => ({
  RateLimiterRedis: class {
    async get() {
      return null;
    }
    async consume() {}
  },
  RateLimiterRes: class {},
}));
vi.mock("./client", () => ({
  zscalerLookupUrls: mock.lookup,
  ZscalerError: class extends Error {
    constructor(
      public kind: string,
      message: string,
    ) {
      super(message);
    }
  },
}));
import { enqueueZscalerLookup } from "./lookup-queue";

beforeEach(() => {
  vi.resetAllMocks();
  mock.queue.length = 0;
  mock.replies.clear();
  mock.llen.mockResolvedValue(0);
  mock.rpush.mockImplementation(async (_key, value) => {
    mock.queue.push(value);
  });
  mock.lpop.mockImplementation(async () => mock.queue.splice(0, 100));
  mock.get.mockImplementation(async key => mock.replies.get(key) ?? null);
  mock.del.mockImplementation(async key => mock.replies.delete(key));
  const lock = { extend: mock.extend, release: mock.release };
  mock.acquire.mockResolvedValue(lock);
  mock.extend.mockResolvedValue(lock);
  mock.lookup.mockImplementation(async (_credentials, urls: string[]) =>
    urls.map(url => ({
      url,
      urlClassifications: [],
      urlClassificationsWithSecurityAlert: [],
    })),
  );
});

describe("Zscaler drainer error propagation", () => {
  it("returns own reply without draining continuously arriving unrelated work", async () => {
    mock.lookup.mockImplementation(async (_credentials, urls: string[]) => {
      mock.queue.push(
        JSON.stringify({
          id: "later",
          url: "https://later.example",
          at: Date.now(),
        }),
      );
      return urls.map(url => ({
        url,
        urlClassifications: [],
        urlClassificationsWithSecurityAlert: [],
      }));
    });
    await expect(
      enqueueZscalerLookup("org", "https://example.com"),
    ).resolves.toMatchObject({ url: "https://example.com" });
    expect(mock.lookup).toHaveBeenCalledTimes(1);
    expect(mock.queue).toHaveLength(1);
    expect(mock.release).toHaveBeenCalledTimes(1);
  });
  it("shares a batch among local concurrent requests", async () => {
    const results = await Promise.all([
      enqueueZscalerLookup("org", "https://a.example"),
      enqueueZscalerLookup("org", "https://b.example"),
    ]);
    expect(results).toHaveLength(2);
    expect(mock.acquire).toHaveBeenCalledTimes(1);
  });
  it("propagates the original batch write error", async () => {
    const error = new Error("WRONGTYPE reply");
    mock.exec.mockResolvedValue([[error, null]]);
    await expect(
      enqueueZscalerLookup("org", "https://example.com"),
    ).rejects.toBe(error);
    expect(mock.release).toHaveBeenCalledTimes(1);
  });
  it("preserves both lookup Redis failure and lock cleanup failure", async () => {
    const body = new Error("read failed"),
      cleanup = new Error("release failed");
    mock.lpop.mockRejectedValue(body);
    mock.release.mockRejectedValue(cleanup);
    await expect(
      enqueueZscalerLookup("org", "https://example.com"),
    ).rejects.toMatchObject({ errors: [body, cleanup] });
  });
  it("propagates lock release errors after a completed batch", async () => {
    const error = new Error("release failed");
    mock.release.mockRejectedValue(error);
    await expect(
      enqueueZscalerLookup("org", "https://example.com"),
    ).rejects.toBe(error);
  });
});
