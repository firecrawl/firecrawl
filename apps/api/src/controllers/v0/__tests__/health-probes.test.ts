import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  config,
  db,
  dbRr,
  getRedisConnection,
  nuqSelect1,
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
      NUQ_DATABASE_URL: "postgres://localhost/nuq",
    },
    db: { execute: vi.fn<() => Promise<unknown>>() },
    dbRr: { execute: vi.fn<() => Promise<unknown>>() },
    getRedisConnection: vi.fn(() => queueRedis),
    nuqSelect1: vi.fn<() => Promise<void>>(),
    queueRedis,
    redisRateLimitClient,
  };
});

vi.mock("../../../config", () => ({ config }));
vi.mock("../../../db/connection", () => ({ db, dbRr }));
vi.mock("../../../services/queue-service", () => ({ getRedisConnection }));
vi.mock("../../../services/rate-limiter", () => ({ redisRateLimitClient }));
vi.mock("../../../services/worker/nuq", () => ({ nuqSelect1 }));

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
  nuqSelect1.mockResolvedValue(undefined);
  getRedisConnection.mockReturnValue(queueRedis);
});

describe("livenessController", () => {
  it("returns 200 while Redis clients are not ended", async () => {
    const res = makeResponse();
    await livenessController({} as Request, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ status: "ok" });
    expect(queueRedis.ping).not.toHaveBeenCalled();
    expect(redisRateLimitClient.ping).not.toHaveBeenCalled();
  });

  it("returns 503 when the rate-limit Redis client is ended", async () => {
    redisRateLimitClient.status = "end";
    const res = makeResponse();
    await livenessController({} as Request, res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ status: "unhealthy" });
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
    expect(dbRr.execute).toHaveBeenCalledTimes(1);
    expect(nuqSelect1).toHaveBeenCalledTimes(1);
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
  });

  it("returns 503 JSON when Postgres SELECT 1 fails", async () => {
    db.execute.mockRejectedValue(new Error("connection refused"));
    const res = makeResponse();
    await readinessController({} as Request, res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      status: "unhealthy",
      failed: ["postgres"],
    });
  });
});
