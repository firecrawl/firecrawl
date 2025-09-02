import { redisEvictConnection } from "../../../services/redis";
import {
  saveDeepResearch,
  getDeepResearch,
  updateDeepResearch,
  getDeepResearchExpiry,
  StoredDeepResearch,
} from "../../../lib/deep-research/deep-research-redis";

jest.mock("../../../services/queue-service", () => ({
  redisConnection: {
    set: jest.fn(),
    get: jest.fn(),
    expire: jest.fn(),
    pttl: jest.fn(),
  },
}));

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
    jest.clearAllMocks();
  });

  describe("saveDeepResearch", () => {
    it("should save research data to Redis with TTL", async () => {
      await saveDeepResearch("test-id", mockResearch);

      expect(redisEvictConnection.set).toHaveBeenCalledWith(
        "deep-research:test-id",
        JSON.stringify(mockResearch),
      );
      expect(redisEvictConnection.expire).toHaveBeenCalledWith(
        "deep-research:test-id",
        6 * 60 * 60,
      );
    });
  });

  describe("getDeepResearch", () => {
    it("should retrieve research data from Redis", async () => {
      (redisEvictConnection.get as jest.Mock).mockResolvedValue(
        JSON.stringify(mockResearch),
      );

      const result = await getDeepResearch("test-id");
      expect(result).toEqual(mockResearch);
      expect(redisEvictConnection.get).toHaveBeenCalledWith(
        "deep-research:test-id",
      );
    });

    it("should return null when research not found", async () => {
      (redisEvictConnection.get as jest.Mock).mockResolvedValue(null);

      const result = await getDeepResearch("non-existent-id");
      expect(result).toBeNull();
    });
  });

  describe("updateDeepResearch", () => {
    it("should update existing research with new data", async () => {
      (redisEvictConnection.get as jest.Mock).mockResolvedValue(
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
      );
      expect(redisEvictConnection.expire).toHaveBeenCalledWith(
        "deep-research:test-id",
        6 * 60 * 60,
      );
    });

    it("should do nothing if research not found", async () => {
      (redisEvictConnection.get as jest.Mock).mockResolvedValue(null);

      await updateDeepResearch("test-id", { status: "completed" });

      expect(redisEvictConnection.set).not.toHaveBeenCalled();
      expect(redisEvictConnection.expire).not.toHaveBeenCalled();
    });
  });

  describe("getDeepResearchExpiry", () => {
    it("should return correct expiry date", async () => {
      const mockTTL = 3600000; // 1 hour in milliseconds
      (redisEvictConnection.pttl as jest.Mock).mockResolvedValue(mockTTL);

      const result = await getDeepResearchExpiry("test-id");

      expect(result).toBeInstanceOf(Date);
      expect(result.getTime()).toBeCloseTo(
        new Date().getTime() + mockTTL,
        -2, // Allow 100ms precision
      );
    });
  });
});
