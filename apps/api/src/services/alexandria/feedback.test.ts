import { beforeEach, describe, expect, it, vi } from "vitest";

const { exchangeRequest } = vi.hoisted(() => ({ exchangeRequest: vi.fn() }));
vi.mock("./client", () => ({ exchangeRequest }));

import { submitAlexandriaFeedback } from "./feedback";

describe("Alexandria feedback", () => {
  beforeEach(() => exchangeRequest.mockReset());

  it("forwards result feedback without accepting provider attribution", async () => {
    exchangeRequest.mockResolvedValue({ status: 201, body: { success: true } });
    await submitAlexandriaFeedback({
      teamId: "team-1",
      requestId: "feedback-request",
      feedback: {
        target: {
          type: "alexandria_result",
          feedbackRef: "01933161-0000-7000-8000-000000000002",
        },
        rating: "bad",
        issues: ["inaccurate_data"],
        origin: "mcp",
        integration: null,
      },
    });

    expect(exchangeRequest).toHaveBeenCalledWith({
      teamId: "team-1",
      path: "/v1/feedback",
      timeoutMs: 10_000,
      requestId: "feedback-request",
      body: expect.objectContaining({
        kind: "result",
        feedbackRef: "01933161-0000-7000-8000-000000000002",
        rating: "bad",
      }),
    });
    expect(exchangeRequest.mock.calls[0][0].body).not.toHaveProperty(
      "provider",
    );
  });

  it("forwards catalogue coverage requests through the same endpoint", async () => {
    exchangeRequest.mockResolvedValue({ status: 201, body: { success: true } });
    await submitAlexandriaFeedback({
      teamId: "team-1",
      feedback: {
        target: { type: "alexandria_catalog" },
        request: {
          kind: "new_provider",
          need: "A reliable court-records provider",
        },
        origin: "api",
        integration: null,
      },
    });

    expect(exchangeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/v1/feedback",
        body: {
          kind: "coverage_request",
          request: {
            kind: "new_provider",
            need: "A reliable court-records provider",
          },
          note: undefined,
          origin: "api",
          integration: null,
        },
      }),
    );
  });
});
