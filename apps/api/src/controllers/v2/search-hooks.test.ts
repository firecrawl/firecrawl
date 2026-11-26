import express from "express";
import type { Response } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "winston";
import type { search as searchV2 } from "../../search/v2";
import type { BillingModule } from "../../service/modules";

const mocks = vi.hoisted(() => ({
  search: vi.fn<typeof searchV2>(),
  checkUrlsAgainstThreatPolicy: vi.fn(),
  resolveThreatProtection: vi.fn(async (): Promise<{ policy: null }> => ({
    policy: null,
  })),
  removeExplicitResults: vi.fn(),
  projectSearchTotalCredits: vi.fn((_input: { limit: number }) => 0),
  reserveKeylessCredits: vi.fn(async () => ({ ok: true })),
  billingAuthorize: vi.fn<BillingModule["authorize"]>(async () => ({
    ok: true,
  })),
  billingSettle: vi.fn<NonNullable<BillingModule["settle"]>>(
    async () => undefined,
  ),
  billingCharge: vi.fn<BillingModule["charge"]>(async () => undefined),
  billTeam: vi.fn(async () => undefined),
  logRequest: vi.fn(async () => undefined),
  logSearch: vi.fn(async () => undefined),
  logResearchEndpoint: vi.fn(async () => undefined),
  skipBilling: vi.fn(() => false),
}));

vi.mock("../../lib/otel-tracer", () => ({
  SpanKind: { SERVER: 1 },
  withSpan: <T>(_name: string, fn: (span: unknown) => T): T => fn({}),
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

import { z } from "zod";
import { jsonRecordSchema } from "../../lib/json-types";
import type { JsonObject } from "../../lib/json-types";
import { executeSearch } from "../../search/execute";
import type {
  HookHandlers,
  HookPoints,
  ResponsePayload,
} from "../../service/hooks";
import { createService, replaceService } from "../../service/service";
import type { Extension } from "../../service/service";
import { searchController } from "./search";
import type { SearchResponse, TeamFlags } from "./types";

function installHooks(
  hooks?: HookHandlers | Array<HookHandlers>,
  report = vi.fn(),
  request?: Extension["request"],
) {
  const extensions: Array<Extension> = hooks
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
            settle: mocks.billingSettle,
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

const jsonRecordListSchema = z.array(jsonRecordSchema);

function expectJsonObject(value: unknown): JsonObject {
  return jsonRecordSchema.parse(value);
}

function expectObjectList(value: unknown): Array<JsonObject> {
  return jsonRecordListSchema.parse(value);
}

async function postSearch(
  body: JsonObject,
  flags: TeamFlags = {},
): Promise<{ status: number; body: JsonObject }> {
  let captured: unknown;
  const app = express();
  app.use(express.json());
  app.post(
    "/v2/search",
    async (req, res: Response<SearchResponse | ResponsePayload>) => {
      const originalJson = res.json.bind(res);
      res.json = (payload: SearchResponse | ResponsePayload) => {
        captured = payload;
        originalJson(payload);
        return res;
      };
      const authedReq = Object.assign(req, {
        auth: { team_id: "11111111-1111-1111-1111-111111111111" },
        acuc: {
          api_key: "test-key",
          api_key_id: 7,
          team_id: "11111111-1111-1111-1111-111111111111",
          org_id: "org-1",
          flags,
          concurrency_limit: 10,
          rate_limit_multiplier: 1,
          is_paid_plan: false,
        },
      });
      await searchController(authedReq, res);
    },
  );
  const response = await request(app).post("/v2/search").send(body);
  return { status: response.status, body: expectJsonObject(captured) };
}

describe("search lifecycle hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    replaceService(undefined);
    mocks.skipBilling.mockReturnValue(false);
    mocks.resolveThreatProtection.mockResolvedValue({ policy: null });
    mocks.projectSearchTotalCredits.mockReturnValue(0);
    mocks.reserveKeylessCredits.mockResolvedValue({ ok: true });
    mocks.billingAuthorize.mockResolvedValue({ ok: true });
    mocks.billingCharge.mockImplementation(async event =>
      mocks.skipBilling()
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
    const order: Array<string> = [];
    const finishedEvents: Array<HookPoints["search.finished"]["payload"]> = [];
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

    const { status, body: payload } = await postSearch({
      query: "raw query",
      limit: 10,
      sources: ["web"],
    });

    expect(seenBodyQuery).toBe("raw query");
    expect(status).toBe(200);
    expect(mocks.search).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "planned query",
        type: ["web", "news"],
      }),
    );

    const data = expectJsonObject(payload.data);
    expect(payload.success).toBe(true);
    expect(data.web).toEqual([
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
    expect(data.news).toEqual([
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
    const payloadId = typeof payload.id === "string" ? payload.id : undefined;
    expect(finishedEvents).toEqual([
      expect.objectContaining({
        id: payloadId,
        ctx: expect.objectContaining({
          teamId: "11111111-1111-1111-1111-111111111111",
        }),
        results: 3,
        charged: 2,
      }),
    ]);
  });

  it("reserves credits before search.plan runs, chains search.results handlers, and keeps URL-less positions", async () => {
    const order: Array<string> = [];
    mocks.billingAuthorize.mockImplementation(async () => {
      order.push("reserve");
      return { ok: true as const };
    });
    installHooks([
      {
        "search.plan": plan => {
          order.push("plan");
          return {
            ...plan,
            limit: 40,
          };
        },
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

    const { status, body: payload } = await postSearch({
      query: "test",
      limit: 10,
      sources: ["web", "news"],
      safe: true,
    });

    expect(status).toBe(200);
    expect(order).toEqual(["reserve", "plan"]);
    expect(mocks.billingAuthorize).toHaveBeenCalledWith(
      expect.objectContaining({
        caller: { teamId: "11111111-1111-1111-1111-111111111111" },
        operation: "search",
        stage: "reserve",
        requestedUnits: 10,
        state: expect.objectContaining({
          limit: 10,
          sources: [
            expect.objectContaining({ type: "web" }),
            expect.objectContaining({ type: "news" }),
          ],
        }),
      }),
    );

    const data = expectJsonObject(payload.data);
    expect(expectObjectList(data.web).map(item => item.url)).toEqual([
      "https://example.com/safe",
    ]);
    expect(expectObjectList(data.news).map(item => item.title)).toEqual([
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
    const usOnlyMixed = await postSearch(
      { query: "cats", sources: ["web"] },
      { usOnly: true },
    );
    expect(usOnlyMixed.status).toBe(200);
    expect(usOnlyMixed.body.warning).toContain("US-only");
    expect(mocks.search).toHaveBeenCalledTimes(1);
    expect(mocks.search.mock.calls[0]?.[0].type).toEqual(["web"]);

    mocks.search.mockClear();
    installHooks({
      "search.plan": plan => ({
        ...plan,
        sources: ["images"],
      }),
    });
    const usOnlyImages = await postSearch(
      { query: "cats", sources: ["web"] },
      { usOnly: true },
    );
    expect(usOnlyImages.status).toBe(403);
    expect(usOnlyImages.body.code).toBe("US_ONLY_UNAVAILABLE");
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it("omits charged when self-hosted and isolates search.finished observer errors", async () => {
    const events: Array<HookPoints["search.finished"]["payload"]> = [];
    const report = installHooks({
      "search.finished": event => {
        events.push(event);
        throw new Error("observer failure");
      },
    });

    // Unbilled module: charged is undefined; observer error is isolated
    mocks.skipBilling.mockReturnValue(true);
    const res1 = await postSearch({ query: "hello", limit: 5 });
    expect(res1.status).toBe(200);
    expect(events[0]).toEqual(
      expect.objectContaining({
        results: 3,
        charged: undefined,
      }),
    );
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("propagates search.plan and search.results vetoes and preserves output when unregistered", async () => {
    const logger = createLogger({ silent: true });
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
    mocks.skipBilling.mockReturnValue(false);
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

    const logger = createLogger({ silent: true });
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

  it("merges routedResults before operator filtering, preserves categories and multi-source image metadata, and excludes non-billable hits", async () => {
    installHooks({
      "search.plan": (plan, info) => {
        if (info.state) {
          info.state.indexCategory = "docs";
          info.state.nonBillableResultsCount = 1;
          info.state.routedResults = [
            {
              url: "https://docs.example.com/guide",
              title: "Guide",
              description: "Official guide",
              category: "developer",
            },
            {
              url: "https://other.example.org/skip",
              title: "Skip",
              description: "Filtered by site operator",
              category: "developer",
            },
          ];
        }
        return { ...plan, sources: ["images"] };
      },
      "search.results": hits =>
        hits.map(hit =>
          hit.group === "images" ? { ...hit, title: `img:${hit.title}` } : hit,
        ),
    });

    mocks.search.mockResolvedValue({
      images: [
        {
          url: "https://docs.example.com/guide",
          title: "Diagram",
          imageUrl: "https://cdn.example.com/diagram.png",
          imageWidth: 800,
          imageHeight: 600,
          position: 1,
        },
      ],
    });

    const { status, body: payload } = await postSearch({
      query: "site:docs.example.com guide",
      limit: 5,
      sources: ["web", "images"],
    });

    expect(status).toBe(200);
    const data = expectJsonObject(payload.data);
    expect(data.web).toEqual([
      expect.objectContaining({
        url: "https://docs.example.com/guide",
        category: "developer",
        position: 1,
      }),
    ]);
    expect(data.images).toEqual([
      expect.objectContaining({
        url: "https://docs.example.com/guide",
        title: "img:Diagram",
        imageUrl: "https://cdn.example.com/diagram.png",
        imageWidth: 800,
        imageHeight: 600,
        position: 1,
      }),
    ]);
    expect(mocks.billingCharge).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "search",
        results: 1,
        state: expect.objectContaining({
          indexCategory: "docs",
          nonBillableResultsCount: 1,
        }),
      }),
    );
  });

  it("keeps empty web array for empty routedResults and returns 503 with reservation release when tools-only discovery is unavailable", async () => {
    const finishedEvents: Array<HookPoints["search.finished"]["payload"]> = [];
    mocks.billingAuthorize.mockResolvedValue({
      ok: true,
      handle: "reservation-handle",
    });
    installHooks({
      "search.plan": (plan, info) => {
        if (info.state) {
          info.state.routedResults = [];
          info.state.toolsOnly = true;
          info.state.toolsUnavailable = true;
        }
        return { ...plan, sources: [] };
      },
      "search.finished": event => {
        finishedEvents.push(event);
      },
    });

    const res = await postSearch({ query: "tools", limit: 5 });

    expect(res.status).toBe(503);
    expect(res.body).toEqual(
      expect.objectContaining({
        success: false,
        code: "TOOL_DISCOVERY_UNAVAILABLE",
        error: "Tool discovery is temporarily unavailable. Retry the request.",
      }),
    );
    expect(mocks.billingSettle).toHaveBeenCalledWith("reservation-handle", {
      ok: false,
    });
    expect(mocks.billingCharge).not.toHaveBeenCalled();
    expect(finishedEvents).toEqual([
      expect.objectContaining({
        results: 0,
        charged: 0,
        isSuccessful: false,
        response: expect.objectContaining({ web: [] }),
      }),
    ]);
  });

  it("reindexes merged routed web positions and respects explicit hit groups for duplicate URLs", async () => {
    installHooks({
      "search.plan": (plan, info) => {
        if (info.state) {
          info.state.routedResults = [
            {
              url: "https://example.com/routed",
              title: "Routed",
              description: "From router",
              position: 1,
            },
          ];
        }
        return plan;
      },
      "search.results": hits => [
        ...hits,
        {
          url: "https://example.com/shared",
          title: "Added news",
          description: "News summary",
          group: "news",
        },
      ],
    });

    mocks.search.mockResolvedValue({
      web: [
        {
          url: "https://example.com/shared",
          title: "Web hit",
          description: "From web",
          position: 1,
        },
      ],
    });

    const { status, body: payload } = await postSearch({
      query: "example",
      limit: 5,
      sources: ["web"],
    });

    expect(status).toBe(200);
    const data = expectJsonObject(payload.data);
    expect(
      expectObjectList(data.web).map(item => ({
        url: item.url,
        position: item.position,
      })),
    ).toEqual([
      { url: "https://example.com/routed", position: 1 },
      { url: "https://example.com/shared", position: 2 },
    ]);
    expect(data.news).toEqual([
      expect.objectContaining({
        url: "https://example.com/shared",
        title: "Added news",
        snippet: "News summary",
      }),
    ]);
  });
});
