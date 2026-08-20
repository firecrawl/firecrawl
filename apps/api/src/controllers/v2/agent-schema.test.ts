import { describe, expect, it } from "vitest";
import { agentRequestSchema } from "./types";

describe("agentRequestSchema model", () => {
  it("defaults to spark-2 when no model is given", () => {
    expect(
      agentRequestSchema.parse({ prompt: "Find the pricing page" }).model,
    ).toBe("spark-2");
  });

  it("keeps an explicitly requested model", () => {
    for (const model of ["spark-1-pro", "spark-1-mini", "spark-2"] as const) {
      expect(
        agentRequestSchema.parse({ prompt: "Find the pricing page", model })
          .model,
      ).toBe(model);
    }
  });

  it("rejects an unknown model", () => {
    expect(() =>
      agentRequestSchema.parse({
        prompt: "Find the pricing page",
        model: "spark-3",
      }),
    ).toThrow();
  });
});
