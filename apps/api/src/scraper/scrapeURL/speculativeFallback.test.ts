import "dotenv/config";

import { config } from "../../config";
config.ENV = "test";

import { scrapeURL } from ".";
import { scrapeOptions } from "../../controllers/v2/types";
import { CostTracking } from "../../lib/cost-tracking";

/**
 * Regression coverage for the engine waterfall race: a speculative engine that
 * hits a block (401/403/429 with ``proxy: "auto"``) asks for the stealthProxy
 * feature, and that request used to abandon every engine that was still
 * running -- including a browser attempt that was about to return a perfectly
 * good page. The request then retried with the file parsers only and failed.
 *
 * The engines module is faked so the ordering is fully controlled: only the
 * engine selection and the per-engine answers are synthetic, the waterfall,
 * escalation and retry code under test is the real implementation.
 */

type Plan = {
  /** How long this engine takes to answer. */
  delayMs: number;
  statusCode: number;
  markdown?: string;
  html?: string;
};

const harness = vi.hoisted(() => ({
  plans: {} as Record<string, Plan>,
  /** Feature flags seen by every buildFallbackList call, in order. */
  fallbackCalls: [] as string[][],
  /** What getEngineMaxReasonableTime reports per engine. */
  reasonableTimes: {} as Record<string, number>,
}));

vi.mock("./engines", async importOriginal => {
  const actual = await importOriginal<typeof import("./engines")>();

  return {
    ...actual,
    shouldUseIndex: () => false,
    getEngineMaxReasonableTime: (_meta: unknown, engine: string) =>
      harness.reasonableTimes[engine] ?? 30000,
    buildFallbackList: async (meta: { featureFlags: Set<string> }) => {
      const flags = Array.from(meta.featureFlags).sort();
      harness.fallbackCalls.push(flags);
      const engines = flags.includes("stealthProxy")
        ? ["pdf", "document"]
        : ["playwright", "fetch"];
      return engines.map(engine => ({
        engine,
        unsupportedFeatures: new Set<string>(),
      }));
    },
    scrapeURLWithEngine: async (meta: { url: string }, engine: string) => {
      const plan = harness.plans[engine];
      if (plan === undefined) {
        throw new Error("speculativeFallback: no plan for engine " + engine);
      }
      await new Promise(resolve => setTimeout(resolve, plan.delayMs));
      return {
        url: meta.url,
        html: plan.html ?? "",
        markdown: plan.markdown,
        statusCode: plan.statusCode,
        contentType: "text/html",
        proxyUsed: "basic",
      };
    },
  };
});

function scrape(options: Record<string, unknown> = {}) {
  return scrapeURL(
    "test:speculative-fallback",
    "https://example.com/jobs",
    scrapeOptions.parse({ formats: ["markdown"], ...options }),
    { teamId: "test", orgId: null },
    new CostTracking(),
  );
}

function elapsedSince(start: number) {
  return Date.now() - start;
}

describe("speculative fallback escalation", () => {
  beforeEach(() => {
    harness.plans = {};
    harness.fallbackCalls = [];
    harness.reasonableTimes = {};
  });

  it("keeps a browser result that is still running when a waterfalled fetch hits a block", async () => {
    harness.reasonableTimes = { playwright: 100, fetch: 100 };
    harness.plans = {
      playwright: {
        delayMs: 400,
        statusCode: 200,
        markdown: "late browser result",
      },
      // Waterfalled at +100ms, blocked immediately.
      fetch: { delayMs: 5, statusCode: 403 },
    };

    const out = await scrape();

    expect(out.success).toBe(true);
    if (out.success) {
      expect(out.document.markdown).toBe("late browser result");
    }
    // No escalation retry: the browser attempt was never discarded.
    expect(harness.fallbackCalls.length).toBe(1);
    expect(harness.fallbackCalls[0]).not.toContain("stealthProxy");
  });

  it("still escalates and fails when every engine is genuinely blocked", async () => {
    harness.reasonableTimes = { playwright: 100, fetch: 100 };
    harness.plans = {
      // Blocked later than the fetch, so the fetch escalation arrives first.
      playwright: { delayMs: 300, statusCode: 403 },
      fetch: { delayMs: 5, statusCode: 403 },
      // The escalation retry selects the file parsers; they cannot read HTML.
      pdf: { delayMs: 5, statusCode: 200 },
      document: { delayMs: 5, statusCode: 200 },
    };

    const start = Date.now();
    const out = await scrape();

    expect(out.success).toBe(false);
    if (!out.success) {
      expect(String((out.error as Error).message)).toContain(
        "Engines tried: [pdf, document]",
      );
    }
    // The deferred escalation was still honoured once the browser also blocked.
    expect(harness.fallbackCalls.length).toBe(2);
    expect(harness.fallbackCalls[1]).toContain("stealthProxy");
    expect(elapsedSince(start)).toBeLessThan(5000);
  });

  it("still lets the file parser win after an escalation", async () => {
    harness.reasonableTimes = { playwright: 100, fetch: 100 };
    harness.plans = {
      playwright: { delayMs: 5, statusCode: 403 },
      fetch: { delayMs: 5, statusCode: 403 },
      pdf: { delayMs: 5, statusCode: 200, markdown: "pdf text page 1" },
      document: { delayMs: 5, statusCode: 200 },
    };

    const out = await scrape();

    expect(out.success).toBe(true);
    if (out.success) {
      expect(out.document.markdown).toBe("pdf text page 1");
    }
    expect(harness.fallbackCalls.length).toBe(2);
    expect(harness.fallbackCalls[1]).toContain("stealthProxy");
  });

  it("bounds the wait for a hung in-flight engine instead of waiting for the request deadline", async () => {
    harness.reasonableTimes = { playwright: 150, fetch: 150 };
    harness.plans = {
      // Never useful, never answers within the test.
      playwright: { delayMs: 5000, statusCode: 200, markdown: "too late" },
      fetch: { delayMs: 5, statusCode: 403 },
      pdf: { delayMs: 5, statusCode: 200 },
      document: { delayMs: 5, statusCode: 200 },
    };

    const start = Date.now();
    const out = await scrape({ timeout: 60000 });

    expect(out.success).toBe(false);
    expect(harness.fallbackCalls.length).toBe(2);
    expect(harness.fallbackCalls[1]).toContain("stealthProxy");
    // Escalation happened once the hung engine used up its reasonable time,
    // not after the 60s request deadline.
    expect(elapsedSince(start)).toBeLessThan(3000);
  });

  it("keeps enforcing the request deadline", async () => {
    harness.reasonableTimes = { playwright: 100, fetch: 100 };
    harness.plans = {
      playwright: { delayMs: 1500, statusCode: 200, markdown: "too late" },
      fetch: { delayMs: 1500, statusCode: 403 },
    };

    const start = Date.now();
    // The request deadline still terminates the scrape; it surfaces as the
    // timeout error rather than as a completed response.
    await expect(scrape({ timeout: 1000 })).rejects.toThrow(/timed out/i);
    expect(elapsedSince(start)).toBeLessThan(3000);
  });
});
