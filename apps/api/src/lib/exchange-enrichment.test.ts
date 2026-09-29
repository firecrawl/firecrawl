import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config", () => ({
  config: {
    FIRE_EXCHANGE_URL: "https://exchange.test",
    EXCHANGE_ENRICHMENT_ON_SCRAPE: true,
  },
}));
vi.mock("./logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import {
  enrichScrape,
  isEnrichmentCandidateUrl,
  planEnrichment,
  runEnrichmentPlan,
  type EnrichmentPlan,
} from "./exchange-enrichment";

const step = (provider: string, creditsCost = 5) => ({
  provider,
  capability: "people/match",
  creditsCost,
  input: { linkedin_url: "https://www.linkedin.com/in/jane-doe" },
});
const plan = (overrides: Partial<EnrichmentPlan> = {}): EnrichmentPlan => ({
  entity: "person",
  outcome: "profile",
  url: "https://www.linkedin.com/in/jane-doe",
  enabled: true,
  matched: true,
  mode: "waterfall",
  maxCreditsPerUrl: 100,
  version: 3,
  steps: [step("apollo", 30), step("fullenrich", 5)],
  dropped: [],
  maxCredits: 35,
  ...overrides,
});
const json = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as Response;
const context = (fetchImpl: typeof fetch) => ({
  teamId: "team_1",
  requestId: "req_1",
  url: "https://www.linkedin.com/in/jane-doe",
  fetchImpl,
});

describe("candidate URLs", () => {
  it("only pre-filters person profile URLs on the supported host", () => {
    expect(isEnrichmentCandidateUrl("https://www.linkedin.com/in/jane-doe")).toBe(true);
    expect(isEnrichmentCandidateUrl("https://uk.linkedin.com/in/jane-doe/")).toBe(true);
    expect(isEnrichmentCandidateUrl("https://linkedin.com/company/acme")).toBe(false);
    expect(isEnrichmentCandidateUrl("https://notlinkedin.com/in/jane")).toBe(false);
    expect(isEnrichmentCandidateUrl("https://example.com/in/jane")).toBe(false);
  });
});

describe("planning", () => {
  it("asks Exchange for the team's plan with the team header and keeps only a runnable plan", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ plan: plan() }));
    const result = await planEnrichment(context(fetchImpl as unknown as typeof fetch));
    expect(result?.steps.map(s => s.provider)).toEqual(["apollo", "fullenrich"]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://exchange.test/v1/enrichment/plan");
    expect(init.headers["x-exchange-team-id"]).toBe("team_1");
    expect(JSON.parse(init.body)).toEqual({ url: "https://www.linkedin.com/in/jane-doe", outcome: "profile", entity: "person" });
  });
  it("plans nothing when disabled, unmatched, failing, or for a non-profile URL", async () => {
    const disabled = vi.fn().mockResolvedValue(json({ plan: plan({ enabled: false, steps: [] }) }));
    expect(await planEnrichment(context(disabled as unknown as typeof fetch))).toBeNull();
    const unmatched = vi.fn().mockResolvedValue(json({ plan: plan({ matched: false, steps: [] }) }));
    expect(await planEnrichment(context(unmatched as unknown as typeof fetch))).toBeNull();
    const failing = vi.fn().mockResolvedValue(json({ error: "nope" }, 503));
    expect(await planEnrichment(context(failing as unknown as typeof fetch))).toBeNull();
    const throwing = vi.fn().mockRejectedValue(new Error("network"));
    expect(await planEnrichment(context(throwing as unknown as typeof fetch))).toBeNull();
    const company = vi.fn();
    expect(await planEnrichment({ ...context(company as unknown as typeof fetch), url: "https://linkedin.com/company/acme" })).toBeNull();
    expect(company).not.toHaveBeenCalled();
  });
});

describe("running the plan", () => {
  it("falls through a no-match to the next provider and stops at the first match", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ provider: "apollo", capability: "people/match", creditsCost: 30, data: [], records: 0 }))
      .mockResolvedValueOnce(json({ provider: "fullenrich", capability: "people/match", creditsCost: 5, data: { name: "Jane" }, records: 1 }));
    const summary = await runEnrichmentPlan(plan(), context(fetchImpl as unknown as typeof fetch));
    expect(summary).toMatchObject({ status: "matched", provider: "fullenrich", creditsCost: 35, data: { name: "Jane" }, preferenceVersion: 3 });
    expect(summary.attempted.map(a => [a.provider, a.outcome])).toEqual([["apollo", "no_match"], ["fullenrich", "matched"]]);
    const [, init] = fetchImpl.mock.calls[1];
    expect(init.headers["x-exchange-team-id"]).toBe("team_1");
    expect(JSON.parse(init.body)).toEqual({ provider: "fullenrich", capability: "people/match", options: { linkedin_url: "https://www.linkedin.com/in/jane-doe" } });
  });
  it("stops on a provider error without spending on the next step", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ provider: "apollo", capability: "people/match", error: { code: "provider_timeout", message: "slow", status: 504 } }, 504));
    const summary = await runEnrichmentPlan(plan(), context(fetchImpl as unknown as typeof fetch));
    expect(summary.status).toBe("error");
    expect(summary.attempted).toEqual([{ provider: "apollo", capability: "people/match", outcome: "error", creditsCost: 0, error: { code: "provider_timeout", message: "slow" } }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("runs one step in single mode and skips a step the budget cannot cover", async () => {
    const single = vi.fn().mockResolvedValueOnce(json({ provider: "apollo", capability: "people/match", creditsCost: 30, data: null, records: 0 }));
    const one = await runEnrichmentPlan(plan({ mode: "single" }), context(single as unknown as typeof fetch));
    expect(one.status).toBe("no_match");
    expect(single).toHaveBeenCalledTimes(1);
    const capped = vi.fn().mockResolvedValueOnce(json({ provider: "apollo", capability: "people/match", creditsCost: 30, data: [], records: 0 }));
    const over = await runEnrichmentPlan(plan({ maxCredits: 30 }), context(capped as unknown as typeof fetch));
    expect(over.status).toBe("budget_exceeded");
    expect(over.attempted.at(-1)).toMatchObject({ provider: "fullenrich", outcome: "skipped" });
    expect(capped).toHaveBeenCalledTimes(1);
  });
});

describe("enrichScrape", () => {
  it("plans then runs, and returns nothing to attach when there is no plan", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ plan: plan({ mode: "single", steps: [step("apollo", 30)], maxCredits: 30 }) }))
      .mockResolvedValueOnce(json({ provider: "apollo", capability: "people/match", creditsCost: 30, data: { name: "Jane" }, records: 1 }));
    expect(await enrichScrape(context(fetchImpl as unknown as typeof fetch))).toMatchObject({ status: "matched", provider: "apollo", creditsCost: 30 });
    const none = vi.fn().mockResolvedValueOnce(json({ plan: plan({ enabled: false, steps: [] }) }));
    expect(await enrichScrape(context(none as unknown as typeof fetch))).toBeUndefined();
  });
});
