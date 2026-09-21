import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recordEndpointFeedback: vi.fn(),
  submitAlexandriaFeedback: vi.fn(),
}));
vi.mock("./record", () => ({
  recordEndpointFeedback: mocks.recordEndpointFeedback,
}));
vi.mock("../../../services/alexandria/feedback", () => ({
  submitAlexandriaFeedback: mocks.submitAlexandriaFeedback,
}));

import { feedbackController } from "./controller";

function response() {
  const state = { status: 0, body: undefined as unknown };
  const res = {
    status(code: number) {
      state.status = code;
      return res;
    },
    json(body: unknown) {
      state.body = body;
      return res;
    },
  };
  return { res, state };
}

describe("unified feedback controller", () => {
  beforeEach(() => vi.clearAllMocks());

  it("routes Alexandria result feedback to Exchange", async () => {
    mocks.submitAlexandriaFeedback.mockResolvedValue({
      status: 201,
      body: {
        success: true,
        feedbackId: "feedback-1",
        provider: "provider-one",
        capability: "companies/search",
      },
    });
    const { res, state } = response();
    await feedbackController(
      {
        auth: { team_id: "team-1" },
        get: (name: string) =>
          name === "x-request-id" ? "request-1" : undefined,
        body: {
          target: {
            type: "alexandria_result",
            feedbackRef: "01933161-0000-7000-8000-000000000002",
          },
          rating: "bad",
          issues: ["inaccurate_data"],
        },
      } as any,
      res as any,
    );

    expect(mocks.submitAlexandriaFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: "team-1", requestId: "request-1" }),
    );
    expect(mocks.recordEndpointFeedback).not.toHaveBeenCalled();
    expect(state).toMatchObject({
      status: 200,
      body: {
        success: true,
        feedbackId: "feedback-1",
        provider: "provider-one",
        capability: "companies/search",
      },
    });
  });

  it("keeps typed Firecrawl jobs on the existing feedback and refund path", async () => {
    mocks.recordEndpointFeedback.mockResolvedValue({
      status: 200,
      body: { success: true, feedbackId: "feedback-2", creditsRefunded: 0 },
    });
    const { res } = response();
    await feedbackController(
      {
        auth: { team_id: "team-1" },
        body: {
          target: {
            type: "firecrawl_job",
            endpoint: "scrape",
            jobId: "01933161-0000-7000-8000-000000000003",
          },
          rating: "partial",
          issues: ["blocked"],
        },
      } as any,
      res as any,
    );

    expect(mocks.recordEndpointFeedback).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        endpoint: "scrape",
        jobId: "01933161-0000-7000-8000-000000000003",
      }),
    );
    expect(mocks.submitAlexandriaFeedback).not.toHaveBeenCalled();
  });
});
