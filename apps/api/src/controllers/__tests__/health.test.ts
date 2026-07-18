import type { Request, Response } from "express";
import { vi } from "vitest";

const {
  getRedisConnection,
  logger,
  queueRedis,
  queueRedisProbe,
  redisRateLimitClient,
  redisRateLimitProbe,
} = vi.hoisted(() => {
  function makeProbe() {
    return {
      status: "ready",
      ping: vi.fn<() => Promise<unknown>>(),
      disconnect: vi.fn(),
    };
  }

  function makeClient(probe: ReturnType<typeof makeProbe>) {
    return {
      status: "ready",
      duplicate: vi.fn(() => probe),
    };
  }

  const queueRedisProbe = makeProbe();
  const redisRateLimitProbe = makeProbe();
  const queueRedis = makeClient(queueRedisProbe);
  const redisRateLimitClient = makeClient(redisRateLimitProbe);

  return {
    getRedisConnection: vi.fn(() => queueRedis),
    logger: { warn: vi.fn() },
    queueRedis,
    queueRedisProbe,
    redisRateLimitClient,
    redisRateLimitProbe,
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
  queueRedisProbe.status = "ready";
  redisRateLimitClient.status = "ready";
  redisRateLimitProbe.status = "ready";
  queueRedisProbe.ping.mockResolvedValue("PONG");
  redisRateLimitProbe.ping.mockResolvedValue("PONG");
  queueRedis.duplicate.mockReturnValue(queueRedisProbe);
  redisRateLimitClient.duplicate.mockReturnValue(redisRateLimitProbe);
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
    expect(queueRedisProbe.ping).not.toHaveBeenCalled();
    expect(redisRateLimitProbe.ping).not.toHaveBeenCalled();
  });
});

describe("readinessController", () => {
  it("preserves the existing response when both Redis clients are healthy", async () => {
    const res = makeResponse();

    await readinessController({} as Request, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ status: "ok" });
    expect(queueRedisProbe.ping).toHaveBeenCalledTimes(1);
    expect(redisRateLimitProbe.ping).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("returns unavailable when a shared Redis client rejects", async () => {
    const error = new Error("connection refused");
    queueRedisProbe.ping.mockRejectedValue(error);
    const res = makeResponse();

    await readinessController({} as Request, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ status: "unhealthy" });
    expect(queueRedisProbe.disconnect).toHaveBeenCalledTimes(1);
    expect(redisRateLimitProbe.ping).toHaveBeenCalledTimes(1);
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
    expect(queueRedisProbe.ping).toHaveBeenCalledTimes(1);
    expect(redisRateLimitProbe.ping).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "Readiness Redis dependency is not ready",
      {
        dependency: "redisRateLimitClient",
        status: "reconnecting",
        probeStatus: "ready",
      },
    );
  });

  it("resets a dedicated probe connection when a command times out", async () => {
    queueRedisProbe.ping.mockRejectedValue(new Error("Command timed out"));
    const res = makeResponse();

    await readinessController({} as Request, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ status: "unhealthy" });
    expect(queueRedisProbe.disconnect).toHaveBeenCalledTimes(1);
    expect(queueRedis.duplicate).toHaveBeenCalledWith({
      commandTimeout: READINESS_CHECK_TIMEOUT_MS,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
    });
    expect(redisRateLimitProbe.ping).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "Readiness Redis dependency check failed",
      {
        dependency: "queueRedis",
        error: expect.objectContaining({
          message: "Command timed out",
        }),
      },
    );
  });
});
