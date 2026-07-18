import type { Request, Response } from "express";
import { vi } from "vitest";

const { getRedisConnection, logger, queueRedis, redisRateLimitClient } =
  vi.hoisted(() => {
    const queueRedis = {
      status: "ready",
      ping: vi.fn<() => Promise<unknown>>(),
    };
    const redisRateLimitClient = {
      status: "ready",
      ping: vi.fn<() => Promise<unknown>>(),
    };

    return {
      getRedisConnection: vi.fn(() => queueRedis),
      logger: { warn: vi.fn() },
      queueRedis,
      redisRateLimitClient,
    };
  });

vi.mock("../../services/queue-service", () => ({ getRedisConnection }));
vi.mock("../../services/rate-limiter", () => ({ redisRateLimitClient }));
vi.mock("../../lib/logger", () => ({ logger }));

import { livenessController } from "../v0/liveness";
import {
  readinessController,
  READINESS_CHECK_TIMEOUT_MS,
} from "../v0/readiness";

function makeResponse() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response & {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  queueRedis.status = "ready";
  redisRateLimitClient.status = "ready";
  queueRedis.ping.mockResolvedValue("PONG");
  redisRateLimitClient.ping.mockResolvedValue("PONG");
  getRedisConnection.mockReturnValue(queueRedis);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("livenessController", () => {
  it("stays dependency-independent", async () => {
    const res = makeResponse();

    await livenessController({} as Request, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ status: "ok" });
    expect(getRedisConnection).not.toHaveBeenCalled();
    expect(queueRedis.ping).not.toHaveBeenCalled();
    expect(redisRateLimitClient.ping).not.toHaveBeenCalled();
  });
});

describe("readinessController", () => {
  it("preserves the existing response when both Redis clients are healthy", async () => {
    const res = makeResponse();

    await readinessController({} as Request, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ status: "ok" });
    expect(getRedisConnection).toHaveBeenCalledTimes(1);
    expect(queueRedis.ping).toHaveBeenCalledTimes(1);
    expect(redisRateLimitClient.ping).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("returns unavailable when a shared Redis client rejects", async () => {
    const error = new Error("connection refused");
    queueRedis.ping.mockRejectedValue(error);
    const res = makeResponse();

    await readinessController({} as Request, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ status: "unhealthy" });
    expect(redisRateLimitClient.ping).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "Readiness Redis dependency check failed",
      { dependency: "queueRedis", error },
    );
  });

  it("does not queue a ping while a shared Redis client is reconnecting", async () => {
    redisRateLimitClient.status = "reconnecting";
    const res = makeResponse();

    await readinessController({} as Request, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ status: "unhealthy" });
    expect(queueRedis.ping).toHaveBeenCalledTimes(1);
    expect(redisRateLimitClient.ping).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "Readiness Redis dependency is not ready",
      {
        dependency: "redisRateLimitClient",
        status: "reconnecting",
      },
    );
  });

  it("returns unavailable when a shared Redis client times out", async () => {
    vi.useFakeTimers();
    queueRedis.ping.mockImplementation(() => new Promise(() => {}));
    const res = makeResponse();

    const response = readinessController({} as Request, res);
    await vi.advanceTimersByTimeAsync(READINESS_CHECK_TIMEOUT_MS);
    await response;

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ status: "unhealthy" });
    expect(redisRateLimitClient.ping).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "Readiness Redis dependency check failed",
      {
        dependency: "queueRedis",
        error: expect.objectContaining({
          message: "Redis readiness check timed out",
        }),
      },
    );
  });
});
