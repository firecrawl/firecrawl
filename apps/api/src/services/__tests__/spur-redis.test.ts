import { vi, describe, it, expect, beforeEach } from "vitest";
const mocks = vi.hoisted(() => ({
  config: { SPUR_REDIS_URL: undefined as string | undefined },
  shared: { identity: "rate-limiter" },
  dedicated: { on: vi.fn() },
  Redis: vi.fn(),
}));
vi.mock("../../config", () => ({ config: mocks.config }));
vi.mock("../rate-limiter", () => ({ redisRateLimitClient: mocks.shared }));
vi.mock("ioredis", () => ({ default: mocks.Redis }));
vi.mock("../../lib/logger", () => ({ logger: { warn: vi.fn() } }));
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.Redis.mockImplementation(function () {
    return mocks.dedicated;
  });
});
describe("Spur Redis routing", () => {
  it("retains the shared client when no dedicated URL is configured", async () => {
    mocks.config.SPUR_REDIS_URL = undefined;
    expect((await import("../spur-redis.js")).redisSpurClient).toBe(
      mocks.shared,
    );
    expect(mocks.Redis).not.toHaveBeenCalled();
  });
  it("routes only Spur to the configured client with bounded failure handling", async () => {
    mocks.config.SPUR_REDIS_URL = "redis://dedicated:6379";
    expect((await import("../spur-redis.js")).redisSpurClient).toBe(
      mocks.dedicated,
    );
    expect(mocks.Redis).toHaveBeenCalledWith(
      "redis://dedicated:6379",
      expect.objectContaining({
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        commandTimeout: 1000,
      }),
    );
    expect(mocks.dedicated.on).toHaveBeenCalledWith(
      "error",
      expect.any(Function),
    );
  });
});
