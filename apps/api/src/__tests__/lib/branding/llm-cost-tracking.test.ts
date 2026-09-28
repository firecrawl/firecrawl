import { vi, describe, it, expect, beforeEach } from "vitest";
import type { Mock } from "vitest";
import { generateObject, NoObjectGeneratedError } from "ai";

vi.mock("ai", async importOriginal => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateObject: vi.fn(),
}));
vi.mock("../../../lib/generic-ai", () => ({
  getModel: vi.fn().mockReturnValue({}),
}));

import { enhanceBrandingWithLLM } from "../../../lib/branding/llm";
import { CostTracking } from "../../../lib/cost-tracking";
import { logger } from "../../../lib/logger";

const run = (costTracking: CostTracking) =>
  enhanceBrandingWithLLM({
    jsAnalysis: {},
    buttons: [],
    url: "https://example.com",
    costTracking,
    logger,
  });

beforeEach(() => {
  (generateObject as Mock).mockReset();
});

describe("branding LLM cost tracking", () => {
  it("records a successful call with its model, tokens and cost", async () => {
    (generateObject as Mock).mockResolvedValueOnce({
      object: {
        cleanedFonts: [],
        buttonClassification: {
          primaryButtonIndex: -1,
          primaryButtonReasoning: "none",
          secondaryButtonIndex: -1,
          secondaryButtonReasoning: "none",
          confidence: 0.5,
        },
        colorRoles: {
          primaryColor: "#000000",
          accentColor: "#ffffff",
          backgroundColor: "#ffffff",
          textPrimary: "#000000",
          confidence: 0.5,
        },
      },
      usage: { inputTokens: 1000, outputTokens: 200 },
    });
    const costTracking = new CostTracking();

    await run(costTracking);

    expect(costTracking.calls).toHaveLength(1);
    const call = costTracking.calls[0];
    expect(call.model).toBe("gpt-4o-mini");
    expect(call.metadata).toEqual({
      module: "branding",
      method: "enhanceBrandingWithLLM",
    });
    expect(call.tokens).toEqual({ input: 1000, output: 200 });
    expect(call.cost).toBeCloseTo((1000 * 0.15 + 200 * 0.6) / 1_000_000, 12);
  });

  it("records a call whose output failed to parse, using the error's usage", async () => {
    (generateObject as Mock).mockRejectedValueOnce(
      new NoObjectGeneratedError({
        message: "No object generated: could not parse the response.",
        text: "not json",
        response: {} as any,
        usage: { inputTokens: 500, outputTokens: 50 } as any,
        finishReason: "stop",
      }),
    );
    const costTracking = new CostTracking();

    const result = await run(costTracking);

    expect(result.buttonClassification.primaryButtonReasoning).toBe(
      "LLM failed",
    );
    expect(costTracking.calls).toHaveLength(1);
    expect(costTracking.calls[0].tokens).toEqual({ input: 500, output: 50 });
    expect(costTracking.calls[0].cost).toBeGreaterThan(0);
  });

  it("records nothing when the request itself failed", async () => {
    (generateObject as Mock).mockRejectedValueOnce(
      new Error("connection reset"),
    );
    const costTracking = new CostTracking();

    await run(costTracking);

    expect(costTracking.calls).toHaveLength(0);
  });

  it("propagates a cost limit instead of treating it as an LLM failure", async () => {
    (generateObject as Mock).mockResolvedValueOnce({
      object: {},
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
    });

    await expect(run(new CostTracking(0.01))).rejects.toThrow(
      "Cost limit exceeded",
    );
  });
});
