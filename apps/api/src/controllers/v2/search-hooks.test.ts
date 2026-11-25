import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  checkUrlsAgainstThreatPolicy: vi.fn(),
  resolveThreatProtection: vi.fn(async (): Promise<any> => ({ policy: null })),
  removeExplicitResults: vi.fn(),
  projectSearchTotalCredits: vi.fn((..._args: any[]) => 0),
  reserveKeylessCredits: vi.fn(async (..._args: any[]) => ({ ok: true })),
  billingAuthorize: vi.fn(async (..._args: any[]) => ({ ok: true as const })),
  billingCharge: vi.fn(
    async (..._args: any[]): Promise<number | undefined> => undefined,
  ),
  billTeam: vi.fn(async () => undefined),
  logRequest: vi.fn(async () => undefined),
  logSearch: vi.fn(async () => undefined),
  logResearchEndpoint: vi.fn(async () => undefined),
  isSelfHosted: vi.fn(() => false),
}));

vi.mock("../../lib/deployment", () => ({
  isSelfHosted: mocks.isSelfHosted,
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

vi.mock("../../search/scrape", () => ({
  getItemsToScrape: vi.fn(() => []),
  scrapeSearchResults: vi.fn(),
  mergeScrapedContent: vi.fn(),
  calculateScrapeCredits: vi.fn(() => 0),
}));

import { executeSearch } from "../../search/execute";
import type { HookHandlers } from "../../service/hooks";
import {
  createService,
  replaceService,
  type Extension,
} from "../../service/service";
import { searchController } from "./search";

function installHooks(
  hooks?: HookHandlers | HookHandlers[],
  report = vi.fn(),
  request?: Extension["request"],
) {
  const extensions: Extension[] = hooks
    ? (Array.isArray(hooks) ? hooks : [hooks]).map((h, i) => ({
        name: `test-hooks-${i}`,
        hooks: h,
      }))
    : [];
  if (request) {
    extensions.push({ name: "test-request", request });
  }
  replaceService(
    createService(
      {
        modules: {
          billing: {
            authorize: mocks.billingAuthorize,
            charge: mocks.billingCharge,
          },
        },
        extensions,
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
    mocks.billingAuthorize.mockResolvedValue({ ok: true });
    mocks.billingCharge.mockImplementation(async (event: any) =>
      mocks.isSelfHosted()
        ? undefined
        : event.kind === "search"
          ? Math.ceil(event.results / 10) * 2
          : undefined,
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
      expect.objectContaining({
        id: payload.id,
        ctx: expect.objectContaining({
          teamId: "11111111-1111-1111-1111-111111111111",
        }),
        results: 3,
        charged: 2,
      }),
    ]);
  });

  it("reserves keyless credits against the planned limit, chains search.results handlers, and keeps URL-less positions", async () => {
    installHooks([
      {
        "search.plan": plan => ({
          ...plan,
          limit: 40,
        }),
        "search.results": hits => [
          ...hits,
          { url: "https://evil.example.com/phish", title: "Phish" },
          { url: "https://explicit.example.com/nsfw", title: "NSFW" },
        ],
      },
      {
        "search.results": hits =>
          hits.filter(
            hit =>
              !hit.url.includes("evil.example.com") &&
              !hit.url.includes("explicit.example.com"),
          ),
      },
    ]);

    mocks.projectSearchTotalCredits.mockImplementation(
      (input: { limit: number }) => Math.ceil(input.limit / 10) * 2,
    );
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
    expect(mocks.billingAuthorize).toHaveBeenCalledWith(
      expect.objectContaining({
        caller: { teamId: "11111111-1111-1111-1111-111111111111" },
        operation: "search",
        stage: "reserve",
        requestedUnits: 40,
        state: expect.objectContaining({ limit: 40 }),
      }),
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

  it("revalidates planned sources against US-only policies before billing and execution", async () => {
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

  it("omits charged when self-hosted and isolates search.finished observer errors", async () => {
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
    expect(report).toHaveBeenCalledTimes(1);
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

  it("caps index-category search.results additions to limit", async () => {
    mocks.isSelfHosted.mockReturnValue(false);
    installHooks({
      "search.plan": plan => ({
        ...plan,
        sources: [],
      }),
      "search.results": hits => [
        ...hits,
        { url: "https://docs.example.com/1", title: "Dev 1" },
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

    expect(devResult.totalResultsCount).toBe(2);
    expect(devResult.response.web?.map(item => item.url)).toEqual([
      "https://docs.example.com/1",
      "https://docs.example.com/2",
    ]);
  });
});
