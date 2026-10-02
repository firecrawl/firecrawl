import { calculateCost } from "./llmExtract";
import { logger } from "../../../lib/logger";

describe("calculateCost", () => {
  it.each([
    // [model, $ per 1M input tokens, $ per 1M output tokens]
    ["gpt-4o", 2.5, 10],
    ["openai/gpt-4o", 2.5, 10],
    ["gpt-4o-mini", 0.15, 0.6],
    ["gpt-4.1", 2, 8],
    ["gpt-4.1-mini", 0.4, 1.6],
    ["o3-mini", 1.1, 4.4],
    ["openai/o3-mini", 1.1, 4.4],
    ["gemini-2.5-flash-lite", 0.1, 0.4],
    ["google/gemini-2.5-flash-lite", 0.1, 0.4],
    ["gemini-3.5-flash-lite", 0.3, 2.5],
    ["gpt-5-mini", 0.25, 2],
    ["fireworks_ai/accounts/fireworks/models/gpt-oss-20b", 0.05, 0.2],
  ])("prices %s", (model, inputPerM, outputPerM) => {
    expect(calculateCost(model, 1_000_000, 0)).toBeCloseTo(inputPerM, 10);
    expect(calculateCost(model, 0, 1_000_000)).toBeCloseTo(outputPerM, 10);
  });

  it("falls back to the model price table for models not listed locally", () => {
    // gpt-4.1-nano is only in lib/extract/usage/model-prices.ts.
    expect(calculateCost("gpt-4.1-nano", 1_000_000, 1_000_000)).toBeCloseTo(
      0.5,
      10,
    );
  });

  it("keeps tiered pricing for gemini-2.5-pro", () => {
    // Up to 200k input tokens: $1.25 in / $10 out per 1M.
    expect(calculateCost("gemini-2.5-pro", 200_000, 0)).toBeCloseTo(0.25, 10);
    expect(calculateCost("gemini-2.5-pro", 200_000, 1_000_000)).toBeCloseTo(
      10.25,
      10,
    );
    // Above 200k input tokens: $2.50 in / $15 out per 1M.
    expect(calculateCost("gemini-2.5-pro", 200_001, 0)).toBeCloseTo(
      0.5000025,
      10,
    );
    expect(calculateCost("gemini-2.5-pro", 200_001, 1_000_000)).toBeCloseTo(
      15.5000025,
      10,
    );
  });

  it("warns once and returns 0 for an unknown model", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);

    expect(calculateCost("not-a-real-model", 1000, 1000)).toBe(0);
    expect(calculateCost("not-a-real-model", 1000, 1000)).toBe(0);

    const warnings = (warn.mock.calls as unknown[][]).filter(
      ([message]) =>
        typeof message === "string" && message.startsWith("No price for model"),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0][1]).toMatchObject({ model: "not-a-real-model" });
    warn.mockRestore();
  });
});
