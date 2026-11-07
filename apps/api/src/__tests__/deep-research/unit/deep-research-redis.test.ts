import type { Mock } from "vitest";
import { redisEvictConnection } from "../../../services/redis";

const { writeApiJobAccess, redisMock } = vi.hoisted(() => ({
  writeApiJobAccess: vi.fn(async () => true),
  redisMock: {
    set: vi.fn(async () => "OK"),
    get: vi.fn(),
    pttl: vi.fn(),
  },
}));

vi.mock("../../../lib/job-access-store", () => ({ writeApiJobAccess }));
vi.mock("../../../services/redis", () => ({
  redisEvictConnection: redisMock,
}));

import {
  saveDeepResearch,
  getDeepResearch,
  updateDeepResearch,
  getDeepResearchExpiry,
  StoredDeepResearch,
} from "../../../lib/deep-research/deep-research-redis";

describe("Deep Research Redis Operations", () => {
  const mockResearch: StoredDeepResearch = {
    id: "test-id",
    team_id: "team-1",
    createdAt: Date.now(),
    status: "processing",
    currentDepth: 0,
    maxDepth: 5,
    completedSteps: 0,
    totalExpectedSteps: 25,
    findings: [],
    sources: [],
    activities: [],
    summaries: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    writeApiJobAccess.mockResolvedValue(true);
  });

  describe("saveDeepResearch", () => {
    it("should save research data to Redis with TTL", async () => {
      await saveDeepResearch("test-id", mockResearch);

      expect(redisEvictConnection.set).toHaveBeenCalledWith(
        "deep-research:test-id",
        JSON.stringify(mockResearch),
        "EX",
        6 * 60 * 60,
      );
      expect(writeApiJobAccess).toHaveBeenCalledWith({
        id: "test-id",
        teamId: "team-1",
        kind: "deep_research",
        expiresAt: expect.any(Date),
      });
    });

    it("keeps the Redis write when the access refresh fails", async () => {
      writeApiJobAccess.mockRejectedValueOnce(
        new Error("Bigtable unavailable"),
      );

      await expect(
        saveDeepResearch("test-id", mockResearch),
      ).resolves.toBeUndefined();

      expect(redisEvictConnection.set).toHaveBeenCalledOnce();
    });
  });

  describe("getDeepResearch", () => {
    it("should retrieve research data from Redis", async () => {
      (redisEvictConnection.get as Mock).mockResolvedValue(
        JSON.stringify(mockResearch),
      );

      const result = await getDeepResearch("test-id");
      expect(result).toEqual(mockResearch);
      expect(redisEvictConnection.get).toHaveBeenCalledWith(
        "deep-research:test-id",
      );
    });

    it("should return null when research not found", async () => {
      (redisEvictConnection.get as Mock).mockResolvedValue(null);

      const result = await getDeepResearch("non-existent-id");
      expect(result).toBeNull();
    });
  });

  describe("updateDeepResearch", () => {
    it("should update existing research with new data", async () => {
      (redisEvictConnection.get as Mock).mockResolvedValue(
        JSON.stringify(mockResearch),
      );

      const update = {
        status: "completed" as const,
        finalAnalysis: "Test analysis",
        activities: [
          {
            type: "search" as const,
            status: "complete" as const,
            message: "New activity",
            timestamp: new Date().toISOString(),
            depth: 1,
          },
        ],
      };

      await updateDeepResearch("test-id", update);

      const expectedUpdate = {
        ...mockResearch,
        ...update,
        activities: [...mockResearch.activities, ...update.activities],
      };

      expect(redisEvictConnection.set).toHaveBeenCalledWith(
        "deep-research:test-id",
        JSON.stringify(expectedUpdate),
        "EX",
        6 * 60 * 60,
      );
      expect(writeApiJobAccess).toHaveBeenCalledWith({
        id: "test-id",
        teamId: "team-1",
        kind: "deep_research",
        expiresAt: expect.any(Date),
      });
    });

    it("should do nothing if research not found", async () => {
      (redisEvictConnection.get as Mock).mockResolvedValue(null);

      await updateDeepResearch("test-id", { status: "completed" });

      expect(redisEvictConnection.set).not.toHaveBeenCalled();
      expect(writeApiJobAccess).not.toHaveBeenCalled();
    });
  });

  describe("getDeepResearchExpiry", () => {
    it("should return correct expiry date", async () => {
      const mockTTL = 3600000; // 1 hour in milliseconds
      (redisEvictConnection.pttl as Mock).mockResolvedValue(mockTTL);

      const before = Date.now();
      const result = await getDeepResearchExpiry("test-id");

      expect(result).toBeInstanceOf(Date);
      expect(result.getTime()).toBeGreaterThanOrEqual(before + mockTTL - 999);
      expect(result.getTime()).toBeLessThanOrEqual(Date.now() + mockTTL);
    });
  });
});
