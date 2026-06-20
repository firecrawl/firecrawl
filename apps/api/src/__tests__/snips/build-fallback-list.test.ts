/**
 * Unit tests for buildFallbackList engine selection logic.
 *
 * Uses jest.mock to avoid pulling in deep ESM dependencies
 * (uuid, undici, etc.) that the full engine modules transitively import.
 */

// Mock engine implementation modules to avoid their heavy transitive deps.
// buildFallbackList only uses the static engineOptions config, not the handlers.
jest.mock("../../scraper/scrapeURL/engines/document", () => ({
  scrapeDocument: jest.fn(),
  documentMaxReasonableTime: () => 30000,
}));
jest.mock("../../scraper/scrapeURL/engines/fire-engine", () => ({
  scrapeURLWithFireEngineChromeCDP: jest.fn(),
  scrapeURLWithFireEngineTLSClient: jest.fn(),
  fireEngineMaxReasonableTime: () => 30000,
}));
jest.mock("../../scraper/scrapeURL/engines/pdf", () => ({
  scrapePDF: jest.fn(),
  pdfMaxReasonableTime: () => 30000,
}));
jest.mock("../../scraper/scrapeURL/engines/fetch", () => ({
  scrapeURLWithFetch: jest.fn(),
  fetchMaxReasonableTime: () => 30000,
}));
jest.mock("../../scraper/scrapeURL/engines/playwright", () => ({
  scrapeURLWithPlaywright: jest.fn(),
  playwrightMaxReasonableTime: () => 30000,
}));
jest.mock("../../scraper/scrapeURL/engines/index/index", () => ({
  scrapeURLWithIndex: jest.fn(),
  indexMaxReasonableTime: () => 30000,
}));
jest.mock("../../scraper/scrapeURL/engines/wikipedia", () => ({
  scrapeURLWithWikipedia: jest.fn(),
  wikipediaMaxReasonableTime: () => 30000,
  isWikimediaUrl: () => false,
}));
jest.mock("../../services", () => ({
  queryEngpickerVerdict: jest.fn(),
  useIndex: false,
}));
jest.mock("../../controllers/v2/types", () => ({
  getPDFMaxPages: () => undefined,
}));
jest.mock("../../lib/format-utils", () => ({
  hasFormatOfType: () => undefined,
}));

import {
  buildFallbackList,
  FeatureFlag,
  Engine,
} from "../../scraper/scrapeURL/engines";
import { Meta } from "../../scraper/scrapeURL";
import { logger } from "../../lib/logger";
import { AbortManager } from "../../scraper/scrapeURL/lib/abortManager";
import { CostTracking } from "../../lib/cost-tracking";

function createMockMeta(overrides: {
  featureFlags: Set<FeatureFlag>;
  forceEngine: Engine[];
}): Meta {
  return {
    id: "test-id",
    url: "https://example.com",
    options: {
      formats: [{ type: "markdown" as const }],
      waitFor: 0,
      timeout: 30000,
      skipTlsVerification: true,
    },
    internalOptions: {
      teamId: "test-team",
      forceEngine: overrides.forceEngine,
    },
    logger: logger.child({ module: "test" }),
    abort: new AbortManager(),
    featureFlags: overrides.featureFlags,
    mock: null,
    pdfPrefetch: undefined,
    documentPrefetch: undefined,
    costTracking: new CostTracking(),
  } as Meta;
}

describe("buildFallbackList", () => {
  it("should keep stealth engine when stealth proxy + actions are requested", async () => {
    // Simulates: proxy: "stealth" with actions
    // fire-engine;chrome-cdp (quality 50) supports actions but NOT stealthProxy
    // fire-engine;chrome-cdp;stealth (quality -2) supports BOTH actions and stealthProxy
    const meta = createMockMeta({
      featureFlags: new Set(["actions", "stealthProxy"]),
      forceEngine: ["fire-engine;chrome-cdp", "fire-engine;chrome-cdp;stealth"],
    });

    const result = await buildFallbackList(meta);
    const engines = result.map(r => r.engine);

    // The stealth engine must be included since it supports both features
    expect(engines).toContain("fire-engine;chrome-cdp;stealth");

    // The stealth engine should have no unsupported features
    const stealthEntry = result.find(
      r => r.engine === "fire-engine;chrome-cdp;stealth",
    );
    expect(stealthEntry).toBeDefined();
    expect(stealthEntry!.unsupportedFeatures.size).toBe(0);
  });

  it("should still filter negative-quality engines with equal or lower support scores", async () => {
    // When only "actions" is requested (no stealthProxy),
    // fire-engine;chrome-cdp (quality 50) supports actions
    // fire-engine;chrome-cdp;stealth (quality -2) also supports actions
    // Both have the same supportScore, so stealth should be filtered out
    const meta = createMockMeta({
      featureFlags: new Set(["actions"]),
      forceEngine: ["fire-engine;chrome-cdp", "fire-engine;chrome-cdp;stealth"],
    });

    const result = await buildFallbackList(meta);
    const engines = result.map(r => r.engine);

    // Positive-quality engine should be present
    expect(engines).toContain("fire-engine;chrome-cdp");
    // Negative-quality engine with same supportScore should be filtered out
    expect(engines).not.toContain("fire-engine;chrome-cdp;stealth");
  });

  it("should keep both engines when stealth has a higher support score", async () => {
    // With forceEngine, the sort is skipped (order is preserved).
    // This test verifies that both engines survive the filtering step.
    const meta = createMockMeta({
      featureFlags: new Set(["actions", "stealthProxy"]),
      forceEngine: ["fire-engine;chrome-cdp", "fire-engine;chrome-cdp;stealth"],
    });

    const result = await buildFallbackList(meta);
    const engines = result.map(r => r.engine);

    // Both engines should survive - stealth has higher supportScore so it's kept,
    // and the positive-quality engine is kept by default
    expect(engines).toContain("fire-engine;chrome-cdp");
    expect(engines).toContain("fire-engine;chrome-cdp;stealth");
    expect(result.length).toBe(2);
  });

  it("should include retry stealth engines when stealth proxy + actions are requested", async () => {
    const meta = createMockMeta({
      featureFlags: new Set(["actions", "stealthProxy"]),
      forceEngine: [
        "fire-engine;chrome-cdp",
        "fire-engine(retry);chrome-cdp",
        "fire-engine;chrome-cdp;stealth",
        "fire-engine(retry);chrome-cdp;stealth",
      ],
    });

    const result = await buildFallbackList(meta);
    const engines = result.map(r => r.engine);

    // Both stealth engines should be included
    expect(engines).toContain("fire-engine;chrome-cdp;stealth");
    expect(engines).toContain("fire-engine(retry);chrome-cdp;stealth");
  });
});
