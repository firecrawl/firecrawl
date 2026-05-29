import { jest } from "@jest/globals";

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

jest.mock("../../../lib/logger", () => ({
  logger,
}));

const queueRedis = {
  set: jest.fn(),
  get: jest.fn(),
  del: jest.fn(),
};

const getRedisConnection = jest.fn(() => queueRedis);
jest.mock("../../../services/queue-service", () => ({
  getRedisConnection,
}));

const redisRateLimitClient = {
  set: jest.fn(),
  get: jest.fn(),
  del: jest.fn(),
};

jest.mock("../../../services/rate-limiter", () => ({
  redisRateLimitClient,
}));

import { redisHealthController } from "./redis-health";

function mockResponse() {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res;
}

describe("redisHealthController", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    queueRedis.set.mockResolvedValue("OK");
    queueRedis.get.mockResolvedValue("test");
    queueRedis.del.mockResolvedValue(1);
    redisRateLimitClient.set.mockResolvedValue("OK");
    redisRateLimitClient.get.mockResolvedValue("test");
    redisRateLimitClient.del.mockResolvedValue(1);
  });

  it("reuses the shared queue Redis connection for health checks", async () => {
    const res = mockResponse();

    await redisHealthController({} as any, res as any);

    expect(getRedisConnection).toHaveBeenCalledTimes(1);
    expect(queueRedis.set).toHaveBeenCalledWith("test", "test");
    expect(queueRedis.get).toHaveBeenCalledWith("test");
    expect(queueRedis.del).toHaveBeenCalledWith("test");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "healthy",
      details: {
        queueRedis: "healthy",
        redisRateLimitClient: "healthy",
      },
    });
  });
});
