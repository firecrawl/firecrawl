import { vi } from "vitest";
import {
  createSelfHostedSearchFeedbackSubmission,
  getSelfHostedSearchFeedbackJob,
  getSelfHostedSearchFeedbackSubmission,
  saveSelfHostedSearchFeedbackJob,
} from "./search-feedback-redis";
import { redisEvictConnection } from "../services/redis";

vi.mock("../services/redis", () => ({
  redisEvictConnection: {
    get: vi.fn(),
    set: vi.fn(),
  },
}));

describe("self-hosted search feedback Redis store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stores the minimal search job with an expiry", async () => {
    vi.mocked(redisEvictConnection.set).mockResolvedValue("OK");
    const job = {
      id: "01933161-0000-7000-8000-000000000001",
      requestId: "01933161-0000-7000-8000-000000000002",
      teamId: "bypass",
      creditsCost: 2,
      createdAt: Date.now(),
      isSuccessful: true,
      zeroDataRetention: false,
    };

    await saveSelfHostedSearchFeedbackJob(job);

    expect(redisEvictConnection.set).toHaveBeenCalledWith(
      `search-feedback:job:${job.id}`,
      JSON.stringify(job),
      "EX",
      expect.any(Number),
    );
  });

  it("creates one idempotent submission and can read it back", async () => {
    const submission = {
      id: "01933161-0000-7000-8000-000000000003",
      jobId: "01933161-0000-7000-8000-000000000001",
      teamId: "bypass",
      createdAt: Date.now(),
      feedback: {
        rating: "bad",
        missingContent: [{ topic: "GitHub repositories" }],
      },
    };
    vi.mocked(redisEvictConnection.set).mockResolvedValue("OK");
    vi.mocked(redisEvictConnection.get).mockImplementation(async key => {
      if (key === `search-feedback:submission:${submission.jobId}`) {
        return JSON.stringify(submission);
      }
      return null;
    });

    await expect(
      createSelfHostedSearchFeedbackSubmission(submission),
    ).resolves.toBe(true);
    await expect(
      getSelfHostedSearchFeedbackSubmission(submission.jobId),
    ).resolves.toEqual(submission);
    await expect(
      getSelfHostedSearchFeedbackJob(submission.jobId),
    ).resolves.toBeNull();

    expect(redisEvictConnection.set).toHaveBeenCalledWith(
      `search-feedback:submission:${submission.jobId}`,
      JSON.stringify(submission),
      "EX",
      expect.any(Number),
      "NX",
    );
  });

  it("reports a duplicate when Redis rejects the NX write", async () => {
    vi.mocked(redisEvictConnection.set).mockResolvedValue(null);

    await expect(
      createSelfHostedSearchFeedbackSubmission({
        id: "01933161-0000-7000-8000-000000000003",
        jobId: "01933161-0000-7000-8000-000000000001",
        teamId: "bypass",
        createdAt: Date.now(),
        feedback: { rating: "bad" },
      }),
    ).resolves.toBe(false);
  });
});
