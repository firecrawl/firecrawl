import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  config,
  db,
  dbRr,
  getRedisConnection,
  logger,
  nuqHealthCheck,
  queueRedis,
  redisRateLimitClient,
} = vi.hoisted(() => {
  const queueRedis = {
    status: "ready",
    ping: vi.fn<() => Promise<unknown>>(),
  };
  const redisRateLimitClient = {
    status: "ready",
    ping: vi.fn<() => Promise<unknown>>(),
  };
  return {
    config: {
      REDIS_URL: "redis://localhost",
      REDIS_RATE_LIMIT_URL: "redis://localhost",
      USE_DB_AUTHENTICATION: true,
      DATABASE_URL: "postgres://localhost/main",
      DATABASE_REPLICA_URL: undefined as string | undefined,
      NUQ_DATABASE_URL: "postgres://localhost/nuq",
    },
    db: { execute: vi.fn<() => Promise<unknown>>() },
    dbRr: { execute: vi.fn<() => Promise<unknown>>() },
    getRedisConnection: vi.fn(() => queueRedis),
    logger: { warn: vi.fn(), info: vi.fn() },
    nuqHealthCheck: vi.fn<() => Promise<boolean>>(),
    queueRedis,
    redisRateLimitClient,
  };
});

vi.mock("../../../config", () => ({ config }));
vi.mock("../../../db/connection", () => ({ db, dbRr }));
vi.mock("../../../lib/logger", () => ({ logger }));
vi.mock("../../../services/queue-service", () => ({ getRedisConnection }));
vi.mock("../../../services/rate-limiter", () => ({ redisRateLimitClient }));
vi.mock("../../../services/worker/nuq", () => ({ nuqHealthCheck }));

import { livenessController } from "../liveness";
import { readinessController } from "../readiness";

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
  queueRedis.status = "ready";
  redisRateLimitClient.status = "ready";
  queueRedis.ping.mockResolvedValue("PONG");
  redisRateLimitClient.ping.mockResolvedValue("PONG");
  db.execute.mockResolvedValue([]);
  dbRr.execute.mockResolvedValue([]);
  nuqHealthCheck.mockResolvedValue(true);
  getRedisConnection.mockReturnValue(queueRedis);
  config.DATABASE_REPLICA_URL = undefined;
});

describe("livenessController", () => {
  it("returns 200 while Redis clients are not ended", async () => {
    const res = makeResponse();
    await livenessController({} as Request, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ status: "ok" });
    expect(queueRedis.ping).not.toHaveBeenCalled();
    expect(redisRateLimitClient.ping).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("returns 503 when the rate-limit Redis client is ended", async () => {
    redisRateLimitClient.status = "end";
    const res = makeResponse();
    await livenessController({} as Request, res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ status: "unhealthy" });
    expect(logger.warn).toHaveBeenCalledWith("Liveness check failed", {
      module: "health",
      check: "rateLimitRedis",
      status: "end",
    });
  });
});

describe("readinessController", () => {
  it("returns 200 when Redis and Postgres checks pass", async () => {
    const res = makeResponse();
    await readinessController({} as Request, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ status: "ok" });
    expect(queueRedis.ping).toHaveBeenCalledTimes(1);
    expect(redisRateLimitClient.ping).toHaveBeenCalledTimes(1);
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(dbRr.execute).not.toHaveBeenCalled();
    expect(nuqHealthCheck).toHaveBeenCalledTimes(1);
  });

  it("pings the replica only when DATABASE_REPLICA_URL is distinct", async () => {
    config.DATABASE_REPLICA_URL = "postgres://localhost/replica";
    const res = makeResponse();
    await readinessController({} as Request, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(dbRr.execute).toHaveBeenCalledTimes(1);
  });

  it("returns 503 JSON when queue Redis is reconnecting", async () => {
    queueRedis.status = "reconnecting";
    const res = makeResponse();
    await readinessController({} as Request, res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      status: "unhealthy",
      failed: ["queueRedis"],
    });
    expect(queueRedis.ping).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "Readiness check failed",
      expect.objectContaining({ check: "queueRedis" }),
    );
  });

  it("returns 503 JSON when Postgres SELECT 1 fails", async () => {
    const err = new Error("connection refused");
    db.execute.mockRejectedValue(err);
    const res = makeResponse();
    await readinessController({} as Request, res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      status: "unhealthy",
      failed: ["postgres"],
    });
    expect(logger.warn).toHaveBeenCalledWith("Readiness check failed", {
      module: "health",
      check: "postgres",
      error: err,
    });
  });

  it("returns 503 when nuqHealthCheck returns false", async () => {
    nuqHealthCheck.mockResolvedValue(false);
    const res = makeResponse();
    await readinessController({} as Request, res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      status: "unhealthy",
      failed: ["nuqPostgres"],
    });
  });

  it("returns 503 when a check exceeds 4s", async () => {
    vi.useFakeTimers();
    db.execute.mockReturnValue(new Promise(() => {}));
    const res = makeResponse();
    const done = readinessController({} as Request, res);
    await vi.advanceTimersByTimeAsync(4000);
    await done;
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      status: "unhealthy",
      failed: ["postgres"],
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "Readiness check failed",
      expect.objectContaining({
        check: "postgres",
        error: expect.objectContaining({ message: "postgres timed out" }),
      }),
    );
    vi.useRealTimers();
  });
});
