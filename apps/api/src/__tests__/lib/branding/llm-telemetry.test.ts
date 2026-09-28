import { vi, describe, it, expect, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("ai", () => ({
  generateObject: vi.fn(async () => ({
    object: {
      cleanedFonts: [],
      colorRoles: {
        primaryColor: "#000000",
        accentColor: "#000000",
        backgroundColor: "#FFFFFF",
        textPrimary: "#000000",
        confidence: 0.9,
      },
    },
    usage: { inputTokens: 1, outputTokens: 1 },
  })),
}));
vi.mock("../../../lib/generic-ai", () => ({
  getModel: vi.fn().mockReturnValue({}),
}));

import { generateObject } from "ai";
import { enhanceBrandingWithLLM } from "../../../lib/branding/llm";
import { logger } from "../../../lib/logger";
import { CostTracking } from "../../../lib/cost-tracking";

function run(ids: {
  teamId?: string;
  scrapeId?: string;
  zeroDataRetention?: boolean;
}) {
  return enhanceBrandingWithLLM({
    jsAnalysis: {},
    buttons: [],
    url: "https://example.com",
    logger,
    costTracking: new CostTracking(),
    ...ids,
  });
}

function telemetry() {
  const calls = (generateObject as Mock).mock.calls;
  expect(calls).toHaveLength(1);
  return calls[0][0].experimental_telemetry;
}

describe("branding LLM telemetry", () => {
  beforeEach(() => {
    (generateObject as Mock).mockClear();
  });

  it("tags the span with the scrape id and the branding feature", async () => {
    await run({ teamId: "test-team", scrapeId: "test-scrape" });

    expect(telemetry().isEnabled).toBe(true);
    expect(telemetry().recordInputs).toBe(false);
    expect(telemetry().metadata).toEqual({
      teamId: "test-team",
      feature: "branding",
      scrapeId: "test-scrape",
    });
  });

  it("leaves scrapeId out when the caller has none", async () => {
    await run({});

    expect(telemetry().metadata).toEqual({
      teamId: "unknown",
      feature: "branding",
    });
  });

  it("disables telemetry for zero data retention scrapes", async () => {
    await run({
      teamId: "test-team",
      scrapeId: "test-scrape",
      zeroDataRetention: true,
    });

    expect(telemetry().isEnabled).toBe(false);
  });
});
