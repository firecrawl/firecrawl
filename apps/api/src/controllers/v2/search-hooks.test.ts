import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  discoverTools: vi.fn(),
  discoverSkills: vi.fn(),
  verifyTools: vi.fn(),
  inferToolIntent: vi.fn(),
  searchDeveloperCategory: vi.fn(),
  searchGovCategory: vi.fn(),
  searchGovIfRouted: vi.fn(),
  checkUrlsAgainstThreatPolicy: vi.fn(),
  removeExplicitResults: vi.fn(),
  billTeam: vi.fn(async () => undefined),
  logRequest: vi.fn(async () => undefined),
  logSearch: vi.fn(async () => undefined),
  logResearchEndpoint: vi.fn(async () => undefined),
  isSelfHosted: vi.fn(() => false),
}));

vi.mock("../../services/logging/log_job", () => ({
  logRequest: mocks.logRequest,
  logSearch: mocks.logSearch,
  logResearchEndpoint: mocks.logResearchEndpoint,
}));

vi.mock("../../services/billing/credit_billing", () => ({
  billTeam: mocks.billTeam,
}));

vi.mock("../../lib/keyless", () => ({
  KEYLESS_FREE_TIER_LIMIT_MESSAGE: "keyless limit reached",
  adjustKeylessCredits: vi.fn(async () => undefined),
  keylessLimitBody: vi.fn(async () => ({ success: false, error: "limit" })),
  keylessProviderToolsBody: vi.fn(() => ({ success: false, error: "auth" })),
  logKeylessCreditUsage: vi.fn(async () => undefined),
  reserveKeylessCredits: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../../lib/keyless-credit-projection", () => ({
  projectSearchTotalCredits: vi.fn(() => 0),
}));

vi.mock("../../lib/threat-protection/request", () => ({
  resolveThreatProtection: vi.fn(async () => ({ policy: null })),
  checkUrlsAgainstThreatPolicy: mocks.checkUrlsAgainstThreatPolicy,
}));

vi.mock("../../lib/scrape-billing", () => ({
  calculateThreatScanCredits: vi.fn(() => 0),
}));

vi.mock("../../lib/key-restriction", () => ({
  actionTypesOf: () => [],
  formatTypesOf: () => [],
  checkKeyFormatRestriction: vi.fn(async () => ({ allowed: true })),
  checkKeyEndpointRestriction: vi.fn(async () => ({ allowed: true })),
}));

vi.mock("../../lib/alexandria-activity", () => ({
  markAlexandriaActivity: vi.fn(),
}));

vi.mock("../../lib/alexandria-discovery", () => ({
  recordDiscoveredTools: vi.fn(),
}));

vi.mock("../../lib/index-daily-limit", () => ({
  consumeIndexRateLimit: vi.fn(async () => ({ ok: true })),
  indexDailyLimitRefusal: vi.fn(() => ({ error: "limit" })),
  reserveIndexCalls: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../../lib/deployment", () => ({
  isSelfHosted: mocks.isSelfHosted,
}));

vi.mock("../../lib/tracking", () => ({
  trackSearchRequest: vi.fn(async () => undefined),
  trackSearchResults: vi.fn(async () => undefined),
}));

vi.mock("../../lib/otel-tracer", () => ({
  SpanKind: { SERVER: 1 },
  withSpan: (_name: string, fn: (span: any) => unknown) => fn({}),
  setSpanAttributes: vi.fn(),
  recordSpanException: vi.fn(),
}));

vi.mock("../../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock("../../search/v2", () => ({
  search: mocks.search,
}));

vi.mock("../../search/alexandria", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../../search/alexandria")>();
  return {
    ...actual,
    discoverTools: mocks.discoverTools,
  };
});

vi.mock("../../search/skill-cards", () => ({
  discoverSkills: mocks.discoverSkills,
  isSkillsSource: (source: { type: string }) => source.type === "skills",
  SKILLS_DISCOVERY_TIMEOUT_MS: 3000,
}));

vi.mock("../../search/tool-intent", () => ({
  AUTO_TOOLS_WAIT_MS: 300,
  FUSED_FIT_THRESHOLD: 0.2,
  inferToolIntent: mocks.inferToolIntent,
  verifyTools: mocks.verifyTools,
  autoToolsEnabled: () => false,
  queryInferenceEnabled: () => false,
  toolFusionEnabled: () => false,
}));

vi.mock("../../search/developer", () => ({
  wantsDeveloperCategory: () => false,
  searchDeveloperCategory: mocks.searchDeveloperCategory,
}));

vi.mock("../../search/gov", () => ({
  wantsGovCategory: () => false,
  searchGovCategory: mocks.searchGovCategory,
  searchGovIfRouted: mocks.searchGovIfRouted,
  MAX_ROUTED_LIMIT: 10,
}));

vi.mock("../../search/scrape", () => ({
  getItemsToScrape: vi.fn(() => []),
  scrapeSearchResults: vi.fn(),
  mergeScrapedContent: vi.fn(),
  calculateScrapeCredits: vi.fn(() => 0),
}));

vi.mock("../../search/highlights", () => ({
  highlightsEnvReady: () => false,
  runIndexedSearchHighlights: vi.fn(),
  searchHighlightsMode: vi.fn(),
}));

vi.mock("../../search/safe-search", () => ({
  removeExplicitResults: mocks.removeExplicitResults,
}));

import { executeSearch } from "../../search/execute";
import type { HookHandlers } from "../../service/hooks";
import { createService, replaceService } from "../../service/service";
import { searchController } from "./search";

function installHooks(hooks?: HookHandlers, report = vi.fn()) {
  replaceService(
    createService(
      {
        modules: {},
        extensions: hooks ? [{ name: "test-hooks", hooks }] : [],
      },
      {
        core: { name: "core" },
        logger: { error: report },
      },
    ),
  );
  return report;
}

function makeReq(body: Record<string, any>) {
  return {
    body,
    headers: {},
    auth: { team_id: "11111111-1111-1111-1111-111111111111" },
    acuc: { api_key_id: 7, org_id: "org-1", flags: {} },
  } as any;
}

function makeRes() {
  const res: any = {
    status: vi.fn(),
    json: vi.fn(),
    setHeader: vi.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

describe("search lifecycle hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    replaceService(undefined);
    mocks.isSelfHosted.mockReturnValue(false);
    mocks.searchGovIfRouted.mockResolvedValue(null);
    mocks.discoverTools.mockResolvedValue({
      items: [],
      semanticMatches: 0,
    });
    mocks.discoverSkills.mockResolvedValue({ skills: [], succeeded: false });
    mocks.verifyTools.mockImplementation(
      async (_q: string, items: any[]) => items,
    );
    mocks.search.mockResolvedValue({
      web: [
        {
          url: "https://example.com/1",
          title: "One",
          description: "First hit",
          position: 1,
        },
        {
          url: "https://example.com/drop",
          title: "Drop",
          description: "Drop hit",
          position: 2,
        },
      ],
      news: [
        {
          url: "https://news.example.com/1",
          title: "News One",
          snippet: "Original snippet",
          date: "2026-11-24",
          position: 1,
        },
      ],
    });
  });

  afterEach(() => {
    replaceService(undefined);
  });

  it("runs search.plan -> search.results -> search.finished in order and applies transforms", async () => {
    const order: string[] = [];
    const finishedEvents: any[] = [];

    installHooks({
      "search.plan": (plan, info) => {
        order.push(`plan:${info.ctx.teamId}:${plan.query}:${plan.limit}`);
        expect(info.body.query).toBe("raw query");
        return {
          query: "planned query",
          limit: 3,
          sources: ["web", "news"],
        };
      },
      "search.results": (hits, info) => {
        order.push(`results:${info.ctx.teamId}:${hits.length}`);
        return [
          ...hits
            .filter(hit => !hit.url.endsWith("/drop"))
            .map(hit =>
              hit.url === "https://news.example.com/1"
                ? { ...hit, description: "Updated snippet" }
                : hit,
            ),
          {
            url: "https://example.com/added",
            title: "Added",
            description: "Added by hook",
          },
        ];
      },
      "search.finished": event => {
        order.push(`finished:${event.ctx.teamId}:${event.results}`);
        finishedEvents.push(event);
      },
    });

    const res = makeRes();
    await searchController(
      makeReq({ query: "raw query", limit: 10, sources: ["web"] }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mocks.search).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "planned query",
        type: ["web", "news"],
      }),
    );

    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true);
    expect(payload.data.web).toEqual([
      expect.objectContaining({
        url: "https://example.com/1",
        title: "One",
        description: "First hit",
        position: 1,
      }),
      expect.objectContaining({
        url: "https://example.com/added",
        title: "Added",
        description: "Added by hook",
      }),
    ]);
    expect(payload.data.news).toEqual([
      expect.objectContaining({
        url: "https://news.example.com/1",
        title: "News One",
        snippet: "Updated snippet",
        date: "2026-11-24",
      }),
    ]);

    expect(order).toEqual([
      "plan:11111111-1111-1111-1111-111111111111:raw query:10",
      "results:11111111-1111-1111-1111-111111111111:3",
      "finished:11111111-1111-1111-1111-111111111111:3",
    ]);
    expect(finishedEvents).toEqual([
      {
        id: payload.id,
        ctx: expect.objectContaining({
          teamId: "11111111-1111-1111-1111-111111111111",
        }),
        results: 3,
        charged: 2,
      },
    ]);
  });

  it("omits charged when self-hosted and emits search.finished with 0 on tools-unavailable 503", async () => {
    const events: any[] = [];
    const report = installHooks({
      "search.finished": event => {
        events.push(event);
        throw new Error("observer failure");
      },
    });

    // Self-hosted: charged is undefined; observer error is isolated
    mocks.isSelfHosted.mockReturnValue(true);
    const res1 = makeRes();
    await searchController(makeReq({ query: "hello", limit: 5 }), res1);
    expect(res1.status).toHaveBeenCalledWith(200);
    expect(events[0]).toEqual(
      expect.objectContaining({
        results: 3,
        charged: undefined,
      }),
    );

    // Non-self-hosted 503 toolsUnavailable path
    mocks.isSelfHosted.mockReturnValue(false);
    mocks.discoverTools.mockResolvedValue({
      items: [],
      warning: "unavailable",
      unavailable: true,
      semanticMatches: 0,
    });
    const res2 = makeRes();
    await searchController(
      makeReq({ query: "weather", sources: ["alexandria"] }),
      res2,
    );
    expect(res2.status).toHaveBeenCalledWith(503);
    expect(events[1]).toEqual(
      expect.objectContaining({
        results: 0,
        charged: 0,
      }),
    );
    expect(report).toHaveBeenCalledTimes(2);
  });

  it("propagates search.plan and search.results vetoes and preserves output when unregistered", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as any;
    const baseOpts = {
      query: "firecrawl",
      limit: 5,
      sources: [{ type: "web" }],
      timeout: 5000,
    };
    const baseCtx = {
      teamId: "team-1",
      origin: "api",
      apiKeyId: 1,
      flags: {},
      teamPlanClass: undefined,
      requestId: "req-1",
      jobId: "job-1",
      apiVersion: "v2",
    };

    const withoutService = await executeSearch(baseOpts, baseCtx, logger);

    installHooks();
    const withoutHandlers = await executeSearch(baseOpts, baseCtx, logger);
    expect(withoutHandlers.response).toEqual(withoutService.response);
    expect(withoutHandlers.totalResultsCount).toBe(
      withoutService.totalResultsCount,
    );

    installHooks({
      "search.plan": () => {
        throw new Error("plan rejected");
      },
    });
    await expect(executeSearch(baseOpts, baseCtx, logger)).rejects.toThrow(
      "plan rejected",
    );

    installHooks({
      "search.results": () => {
        throw new Error("results rejected");
      },
    });
    await expect(executeSearch(baseOpts, baseCtx, logger)).rejects.toThrow(
      "results rejected",
    );
  });
});
