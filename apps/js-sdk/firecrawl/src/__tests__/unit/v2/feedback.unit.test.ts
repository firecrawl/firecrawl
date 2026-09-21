import { describe, expect, jest, test } from "@jest/globals";
import { feedback, searchFeedback } from "../../../v2/methods/feedback";

describe("v2.feedback unit", () => {
  test("posts Alexandria result feedback to the unified endpoint", async () => {
    const post = jest.fn(async () => ({
      status: 200,
      data: {
        success: true as const,
        feedbackId: "feedback-1",
        creditsRefunded: 0,
      },
    }));
    const result = await feedback(
      { post } as any,
      {
        target: {
          type: "alexandria_result",
          feedbackRef: "01933161-0000-7000-8000-000000000002",
        },
        rating: "partial",
        issues: ["stale_data"],
      },
    );

    expect(post).toHaveBeenCalledWith(
      "/v2/feedback",
      expect.objectContaining({
        target: expect.objectContaining({ type: "alexandria_result" }),
      }),
    );
    expect(result.feedbackId).toBe("feedback-1");
  });

  test("accepts catalogue coverage requests without a rating", async () => {
    const post = jest.fn(async () => ({
      status: 200,
      data: {
        success: true as const,
        feedbackId: "feedback-2",
        creditsRefunded: 0,
      },
    }));
    await feedback(
      { post } as any,
      {
        target: { type: "alexandria_catalog" },
        request: { kind: "new_provider", need: "A court-records provider" },
      },
    );
    expect(post).toHaveBeenCalledWith("/v2/feedback", expect.any(Object));
  });

  test("requires the target-specific identifiers", async () => {
    await expect(
      feedback({ post: jest.fn() } as any, {
        target: { type: "alexandria_result", feedbackRef: "" },
        rating: "bad",
        note: "Provider failed",
      }),
    ).rejects.toThrow("target.feedbackRef is required");
  });

  test("routes the compatibility search method through the unified endpoint", async () => {
    const post = jest.fn(async () => ({
      status: 200,
      data: {
        success: true as const,
        feedbackId: "feedback-3",
        creditsRefunded: 0,
      },
    }));
    await searchFeedback(
      { post } as any,
      "01933161-0000-7000-8000-000000000004",
      { rating: "bad", querySuggestions: "Use a narrower query" },
    );
    expect(post).toHaveBeenCalledWith(
      "/v2/feedback",
      expect.objectContaining({
        target: {
          type: "firecrawl_job",
          endpoint: "search",
          jobId: "01933161-0000-7000-8000-000000000004",
        },
      }),
    );
  });
});
