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
  resolveThreatProtection: vi.fn(async (): Promise<any> => ({ policy: null })),
  removeExplicitResults: vi.fn(),
  projectSearchTotalCredits: vi.fn((..._args: any[]) => 0),
  reserveKeylessCredits: vi.fn(async (..._args: any[]) => ({ ok: true })),
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
  reserveKeylessCredits: mocks.reserveKeylessCredits,
}));

vi.mock("../../lib/keyless-credit-projection", () => ({
  projectSearchTotalCredits: mocks.projectSearchTotalCredits,
}));

vi.mock("../../lib/threat-protection/request", () => ({
  resolveThreatProtection: mocks.resolveThreatProtection,
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
  wantsDeveloperCategory: (categories?: Array<{ type: string } | string>) =>
    Boolean(
      categories?.some(c =>
        typeof c === "string" ? c === "developer" : c.type === "developer",
      ),
    ),
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
import { searchController as v1SearchController } from "../v1/search";
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
    mocks.resolveThreatProtection.mockResolvedValue({ policy: null });
    mocks.projectSearchTotalCredits.mockReturnValue(0);
    mocks.reserveKeylessCredits.mockResolvedValue({ ok: true });
    mocks.searchGovIfRouted.mockResolvedValue(null);
    mocks.searchDeveloperCategory.mockResolvedValue([]);
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
    let seenBodyQuery: string | undefined;

    installHooks({
      "search.plan": (plan, info) => {
        order.push(`plan:${info.ctx.teamId}:${plan.query}:${plan.limit}`);
        seenBodyQuery = info.body.query;
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

    expect(seenBodyQuery).toBe("raw query");
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
        position: 2,
      }),
    ]);
    expect(payload.data.news).toEqual([
      expect.objectContaining({
        url: "https://news.example.com/1",
        title: "News One",
        snippet: "Updated snippet",
        date: "2026-11-24",
        position: 1,
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

  it("reserves keyless credits against the planned limit, filters hook-added hits through threat and safe-search, and keeps URL-less positions", async () => {
    installHooks({
      "search.plan": plan => ({
        ...plan,
        limit: 40,
      }),
      "search.results": hits => [
        ...hits,
        { url: "https://evil.example.com/phish", title: "Phish" },
        { url: "https://explicit.example.com/nsfw", title: "NSFW" },
      ],
    });

    mocks.projectSearchTotalCredits.mockImplementation(
      (input: { limit: number }) => Math.ceil(input.limit / 10) * 2,
    );
    mocks.resolveThreatProtection.mockResolvedValue({
      policy: { mode: "block" },
    });
    mocks.checkUrlsAgainstThreatPolicy.mockImplementation(
      async (urls: string[]) => ({
        decisionsByUrl: new Map(
          urls.map(url => [
            url,
            { allowed: !url.includes("evil.example.com") },
          ]),
        ),
      }),
    );
    mocks.removeExplicitResults.mockImplementation(async (target: any) => {
      if (target.web) {
        target.web = target.web.filter(
          (item: any) => !item.url.includes("explicit.example.com"),
        );
      }
    });
    mocks.search.mockResolvedValue({
      web: [
        {
          url: "https://example.com/safe",
          title: "Safe",
          description: "Safe hit",
          position: 1,
        },
      ],
      news: [
        { url: "https://news.example.com/a", title: "A", snippet: "first" },
        { title: "URL-less middle", snippet: "middle" },
        { url: "https://news.example.com/b", title: "B", snippet: "last" },
      ],
    });

    const res = makeRes();
    await searchController(
      makeReq({
        query: "test",
        limit: 10,
        sources: ["web", "news"],
        safe: true,
      }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mocks.projectSearchTotalCredits).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 40 }),
      expect.anything(),
      false,
    );
    expect(mocks.reserveKeylessCredits).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      8,
    );

    const payload = res.json.mock.calls[0][0];
    expect(payload.data.web.map((item: any) => item.url)).toEqual([
      "https://example.com/safe",
    ]);
    expect(payload.data.news.map((item: any) => item.title)).toEqual([
      "A",
      "URL-less middle",
      "B",
    ]);
  });

  it("revalidates planned sources against preview-keyless, ZDR, and US-only policies before billing and execution", async () => {
    installHooks({
      "search.plan": plan => ({
        ...plan,
        sources: [...plan.sources, "alexandria"],
      }),
    });

    const keylessReq = makeReq({ query: "weather", sources: ["web"] });
    keylessReq.auth.team_id = "preview_keyless_abc";
    const keylessRes = makeRes();
    await searchController(keylessReq, keylessRes);
    expect(keylessRes.status).toHaveBeenCalledWith(403);
    expect(mocks.discoverTools).not.toHaveBeenCalled();
    expect(mocks.search).not.toHaveBeenCalled();
    expect(mocks.reserveKeylessCredits).not.toHaveBeenCalled();

    const zdrReq = makeReq({
      query: "weather",
      sources: ["web"],
      enterprise: ["zdr"],
    });
    zdrReq.acuc.flags = { searchZDR: "allowed" };
    const zdrRes = makeRes();
    await searchController(zdrReq, zdrRes);
    expect(zdrRes.status).toHaveBeenCalledWith(403);
    expect(mocks.discoverTools).not.toHaveBeenCalled();
    expect(mocks.search).not.toHaveBeenCalled();

    installHooks({
      "search.plan": plan => ({
        ...plan,
        sources: [...plan.sources, "images"],
      }),
    });
    const usOnlyMixedReq = makeReq({ query: "cats", sources: ["web"] });
    usOnlyMixedReq.acuc.flags = { usOnly: true };
    const usOnlyMixedRes = makeRes();
    await searchController(usOnlyMixedReq, usOnlyMixedRes);
    expect(usOnlyMixedRes.status).toHaveBeenCalledWith(200);
    expect(usOnlyMixedRes.json.mock.calls[0][0].warning).toContain("US-only");
    expect(mocks.search).toHaveBeenCalledTimes(1);
    expect(mocks.search.mock.calls[0][0].type).toEqual(["web"]);

    mocks.search.mockClear();
    installHooks({
      "search.plan": plan => ({
        ...plan,
        sources: ["images"],
      }),
    });
    const usOnlyImagesReq = makeReq({ query: "cats", sources: ["web"] });
    usOnlyImagesReq.acuc.flags = { usOnly: true };
    const usOnlyImagesRes = makeRes();
    await searchController(usOnlyImagesReq, usOnlyImagesRes);
    expect(usOnlyImagesRes.status).toHaveBeenCalledWith(403);
    expect(usOnlyImagesRes.json.mock.calls[0][0].code).toBe(
      "US_ONLY_UNAVAILABLE",
    );
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it("revalidates v1 planned sources and surfaces warnings with and without a search.plan handler", async () => {
    mocks.search.mockResolvedValue({
      web: [
        {
          url: "https://example.com/v1",
          title: "V1",
          description: "Hit",
          position: 1,
        },
      ],
    });

    // No service installed
    const plainRes = makeRes();
    await v1SearchController(makeReq({ query: "cats", limit: 5 }), plainRes);
    expect(plainRes.status).toHaveBeenCalledWith(200);
    expect(plainRes.json.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        success: true,
        data: [
          {
            url: "https://example.com/v1",
            title: "V1",
            description: "Hit",
          },
        ],
      }),
    );
    expect(plainRes.json.mock.calls[0][0].warning).toBeUndefined();

    // Service installed with no search.plan handler
    installHooks();
    const noHandlerRes = makeRes();
    await v1SearchController(
      makeReq({ query: "cats", limit: 5 }),
      noHandlerRes,
    );
    expect(noHandlerRes.status).toHaveBeenCalledWith(200);
    expect(noHandlerRes.json.mock.calls[0][0].data).toEqual(
      plainRes.json.mock.calls[0][0].data,
    );
    expect(noHandlerRes.json.mock.calls[0][0].warning).toBeUndefined();

    // Keyless 403 when search.plan adds alexandria
    mocks.search.mockClear();
    installHooks({
      "search.plan": plan => ({
        ...plan,
        sources: [...plan.sources, "alexandria"],
      }),
    });
    const keylessReq = makeReq({ query: "weather", limit: 5 });
    keylessReq.auth.team_id = "preview_keyless_v1";
    const keylessRes = makeRes();
    await v1SearchController(keylessReq, keylessRes);
    expect(keylessRes.status).toHaveBeenCalledWith(403);
    expect(mocks.discoverTools).not.toHaveBeenCalled();
    expect(mocks.search).not.toHaveBeenCalled();
    expect(mocks.reserveKeylessCredits).not.toHaveBeenCalled();

    // Empty-query 400 when search.plan adds alexandria and blanks query
    installHooks({
      "search.plan": plan => ({
        ...plan,
        query: "   ",
        sources: [...plan.sources, "alexandria"],
      }),
    });
    const emptyQueryRes = makeRes();
    await v1SearchController(
      makeReq({ query: "weather", limit: 5 }),
      emptyQueryRes,
    );
    expect(emptyQueryRes.status).toHaveBeenCalledWith(400);
    expect(mocks.discoverTools).not.toHaveBeenCalled();
    expect(mocks.search).not.toHaveBeenCalled();

    // ZDR 403 when search.plan adds skills
    installHooks({
      "search.plan": plan => ({
        ...plan,
        sources: [...plan.sources, "skills"],
      }),
    });
    const zdrReq = makeReq({ query: "weather", limit: 5 });
    zdrReq.acuc.flags = { searchZDR: "forced-zdr" };
    const zdrRes = makeRes();
    await v1SearchController(zdrReq, zdrRes);
    expect(zdrRes.status).toHaveBeenCalledWith(403);
    expect(mocks.discoverSkills).not.toHaveBeenCalled();
    expect(mocks.search).not.toHaveBeenCalled();

    // US-only strips images and sets responseData.warning
    installHooks({
      "search.plan": plan => ({
        ...plan,
        sources: [...plan.sources, "images"],
      }),
    });
    const usOnlyMixedReq = makeReq({ query: "cats", limit: 5 });
    usOnlyMixedReq.acuc.flags = { usOnly: true };
    const usOnlyMixedRes = makeRes();
    await v1SearchController(usOnlyMixedReq, usOnlyMixedRes);
    expect(usOnlyMixedRes.status).toHaveBeenCalledWith(200);
    expect(usOnlyMixedRes.json.mock.calls[0][0].warning).toContain("US-only");
    expect(mocks.search).toHaveBeenCalledTimes(1);
    expect(mocks.search.mock.calls[0][0].type).toEqual(["web"]);

    // US-only 403 when search.plan replaces sources with images only
    mocks.search.mockClear();
    installHooks({
      "search.plan": plan => ({
        ...plan,
        sources: ["images"],
      }),
    });
    const usOnlyOnlyImagesReq = makeReq({ query: "cats", limit: 5 });
    usOnlyOnlyImagesReq.acuc.flags = { usOnly: true };
    const usOnlyOnlyImagesRes = makeRes();
    await v1SearchController(usOnlyOnlyImagesReq, usOnlyOnlyImagesRes);
    expect(usOnlyOnlyImagesRes.status).toHaveBeenCalledWith(403);
    expect(usOnlyOnlyImagesRes.json.mock.calls[0][0].code).toBe(
      "US_ONLY_UNAVAILABLE",
    );
    expect(mocks.search).not.toHaveBeenCalled();

    // Carries result.toolsWarning into responseData.warning
    mocks.discoverTools.mockResolvedValue({
      items: [],
      warning: "Tool discovery degraded.",
      semanticMatches: 0,
    });
    installHooks({
      "search.plan": plan => ({
        ...plan,
        sources: [...plan.sources, "alexandria"],
      }),
    });
    const toolsWarnRes = makeRes();
    await v1SearchController(
      makeReq({ query: "weather", limit: 5 }),
      toolsWarnRes,
    );
    expect(toolsWarnRes.status).toHaveBeenCalledWith(200);
    expect(toolsWarnRes.json.mock.calls[0][0].warning).toContain(
      "Tool discovery degraded.",
    );
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

  it("emits search.finished for v1 searches and caps index-category search.results additions to limit", async () => {
    const v1Finished: any[] = [];
    installHooks({
      "search.finished": event => {
        v1Finished.push(event);
      },
    });
    mocks.search.mockResolvedValue({
      web: [
        {
          url: "https://example.com/v1",
          title: "V1",
          description: "Hit",
          position: 1,
        },
      ],
    });

    const v1Res = makeRes();
    await v1SearchController(makeReq({ query: "cats", limit: 5 }), v1Res);
    expect(v1Res.status).toHaveBeenCalledWith(200);
    const v1Payload = v1Res.json.mock.calls[0][0];
    expect(v1Finished[0]).toEqual({
      id: v1Payload.id,
      ctx: expect.objectContaining({
        teamId: "11111111-1111-1111-1111-111111111111",
      }),
      results: 1,
      charged: 2,
    });

    mocks.isSelfHosted.mockReturnValue(true);
    const v1SelfHostedRes = makeRes();
    await v1SearchController(
      makeReq({ query: "cats", limit: 5 }),
      v1SelfHostedRes,
    );
    expect(v1SelfHostedRes.status).toHaveBeenCalledWith(200);
    expect(v1Finished[1]).toEqual(
      expect.objectContaining({
        results: 1,
        charged: undefined,
      }),
    );

    mocks.isSelfHosted.mockReturnValue(false);
    mocks.searchDeveloperCategory.mockResolvedValue([
      {
        url: "https://docs.example.com/1",
        title: "Dev 1",
        description: "One",
        position: 1,
      },
    ]);
    installHooks({
      "search.results": hits => [
        ...hits,
        { url: "https://docs.example.com/2", title: "Dev 2" },
        { url: "https://docs.example.com/3", title: "Dev 3" },
        { url: "https://docs.example.com/4", title: "Dev 4" },
      ],
    });

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as any;
    const devResult = await executeSearch(
      {
        query: "sdk",
        limit: 2,
        sources: [{ type: "web" }],
        categories: [{ type: "developer" }],
        timeout: 5000,
      },
      {
        teamId: "team-1",
        origin: "api",
        apiKeyId: 1,
        flags: {},
        teamPlanClass: undefined,
        requestId: "req-dev",
        jobId: "job-dev",
        apiVersion: "v2",
      },
      logger,
    );

    expect(devResult.indexResultsCount).toBe(2);
    expect(devResult.totalResultsCount).toBe(2);
    expect(devResult.response.web?.map(item => item.url)).toEqual([
      "https://docs.example.com/1",
      "https://docs.example.com/2",
    ]);
  });
});
