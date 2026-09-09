import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  redisGet: vi.fn(),
  redisSet: vi.fn().mockResolvedValue("OK"),
  limit: vi.fn(),
}));

const query = {
  from: vi.fn(() => query),
  where: vi.fn(() => query),
  limit: mocks.limit,
};

vi.mock("../../db/connection", () => ({
  db: { select: vi.fn(() => query) },
  dbRr: { select: vi.fn(() => query) },
}));

vi.mock("../../services/queue-service", () => ({
  getRedisConnection: () => ({
    get: mocks.redisGet,
    set: mocks.redisSet,
  }),
}));

import { isOrgSiemLoggingEnabled } from "./store";

describe("SIEM logging enabled cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redisGet.mockResolvedValue(null);
  });

  it("uses an organization-specific Redis Cluster hash tag", async () => {
    mocks.limit.mockResolvedValue([{ enabled: true }]);

    await expect(isOrgSiemLoggingEnabled("org-one")).resolves.toBe(true);

    expect(mocks.redisGet).toHaveBeenCalledWith(
      "{siemLoggingConfig:org-one}:enabled",
    );
    expect(mocks.redisSet).toHaveBeenCalledWith(
      "{siemLoggingConfig:org-one}:enabled",
      "1",
      "EX",
      60,
    );
  });

  it("treats a missing configuration table as disabled", async () => {
    mocks.limit.mockRejectedValue({
      cause: { code: "42P01" },
    });

    await expect(isOrgSiemLoggingEnabled("org-two")).resolves.toBe(false);
    expect(mocks.redisSet).toHaveBeenCalledWith(
      "{siemLoggingConfig:org-two}:enabled",
      "0",
      "EX",
      60,
    );
  });
});
