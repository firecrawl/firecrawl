import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const crawler = {
    getRobotsTxt: vi.fn(async () => ""),
    importRobotsTxt: vi.fn(),
    tryGetSitemap: vi.fn(async () => 0),
  };

  return {
    crawler,
    billTeam: vi.fn(async () => undefined),
    logMap: vi.fn(async () => undefined),
    logRequest: vi.fn(async () => undefined),
    resolveViaAvgrab: vi.fn(async (): Promise<any[] | null> => null),
    resolveThreatProtection: vi.fn(
      async (): Promise<any> => ({
        policy: null,
      }),
    ),
    checkUrlsAgainstThreatPolicy: vi.fn(async (..._args: any[]) => ({
      decisionsByUrl: new Map<string, any>(),
    })),
    checkPermissions: vi.fn(() => ({})),
    fireEngineMap: vi.fn(async () => [] as any[]),
    queryIndexAtDomainSplitLevelWithMeta: vi.fn(async () => [] as any[]),
    queryIndexAtSplitLevelWithMeta: vi.fn(async () => [] as any[]),
    redisGet: vi.fn(async (): Promise<string | null> => null),
    redisSet: vi.fn(async () => "OK"),
  };
});

vi.mock("../../services/billing/credit_billing", () => ({
  billTeam: mocks.billTeam,
}));

vi.mock("../../services/logging/log_job", () => ({
  logMap: mocks.logMap,
  logRequest: mocks.logRequest,
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

vi.mock("../../lib/permissions", () => ({
  checkPermissions: mocks.checkPermissions,
}));

vi.mock("../../lib/avgrab-resolve", () => ({
  AvgrabResolveError: class AvgrabResolveError extends Error {
    upstreamStatus = 502;
    code = "AVGRAB_ERROR";
  },
  resolveViaAvgrab: mocks.resolveViaAvgrab,
}));

vi.mock("../../lib/threat-protection/request", () => ({
  resolveThreatProtection: mocks.resolveThreatProtection,
  checkUrlsAgainstThreatPolicy: mocks.checkUrlsAgainstThreatPolicy,
}));

vi.mock("../../lib/scrape-billing", () => ({
  calculateThreatScanCredits: vi.fn(() => 0),
}));

vi.mock("../../lib/crawl-redis", () => ({
  crawlToCrawler: vi.fn(() => mocks.crawler),
}));

vi.mock("../../lib/validateUrl", async importOriginal => {
  const actual = await importOriginal<typeof import("../../lib/validateUrl")>();
  return {
    ...actual,
    resolveRedirects: vi.fn(async (url: string) => url),
  };
});

vi.mock("../../search/fireEngine", () => ({
  fireEngineMap: mocks.fireEngineMap,
}));

vi.mock("../../services/redis", () => ({
  redisEvictConnection: {
    get: mocks.redisGet,
    set: mocks.redisSet,
  },
}));

vi.mock("../../services/index", () => ({
  generateDomainSplits: vi.fn((host: string) => [host]),
  generateURLSplits: vi.fn((url: string) => [url]),
  queryIndexAtDomainSplitLevelWithMeta:
    mocks.queryIndexAtDomainSplitLevelWithMeta,
  queryIndexAtSplitLevelWithMeta: mocks.queryIndexAtSplitLevelWithMeta,
}));

import { applyMapCollectHook, getMapResults } from "../../lib/map-utils";
import { requestContext } from "../../lib/request-context";
import type { HookHandlers } from "../../service/hooks";
import { createService, replaceService } from "../../service/service";
import { mapController } from "./map";

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
    auth: { team_id: "team-map-1" },
    acuc: { api_key_id: 9, org_id: "org-1", flags: null },
  } as any;
}

function makeRes() {
  const res: any = {
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

describe("map lifecycle hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    replaceService(undefined);
    mocks.resolveViaAvgrab.mockResolvedValue(null);
    mocks.resolveThreatProtection.mockResolvedValue({ policy: null });
    mocks.checkUrlsAgainstThreatPolicy.mockResolvedValue({
      decisionsByUrl: new Map(),
    });
    mocks.fireEngineMap.mockResolvedValue([]);
    mocks.queryIndexAtDomainSplitLevelWithMeta.mockResolvedValue([]);
    mocks.queryIndexAtSplitLevelWithMeta.mockResolvedValue([]);
    mocks.crawler.tryGetSitemap.mockResolvedValue(0);
  });

  afterEach(() => {
    replaceService(undefined);
  });

  it("runs map.collect before map.finished, transforms URLs while keeping metadata, and slices to limit", async () => {
    const order: string[] = [];
    let finishedId: string | undefined;
    installHooks({
      "map.collect": (urls, info) => {
        order.push(
          `collect:${info.ctx.teamId}:${info.url}:${info.limit}:${urls.length}`,
        );
        return [
          ...urls.filter(u => !u.endsWith("/drop")),
          "https://example.com/added-1",
          "https://example.com/added-2",
        ];
      },
      "map.finished": event => {
        order.push(`finished:${event.ctx.teamId}:${event.urls}`);
        finishedId = event.id;
      },
    });

    mocks.fireEngineMap.mockResolvedValue([
      {
        url: "https://example.com/keep",
        title: "Keep Title",
        description: "Keep Desc",
      },
      {
        url: "https://example.com/drop",
        title: "Drop Title",
        description: "Drop Desc",
      },
    ]);

    const res = makeRes();
    await mapController(
      makeReq({ url: "https://example.com", limit: 2, sitemap: "skip" }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.success).toBe(true);
    expect(finishedId).toBe(body.id);
    expect(body.links).toEqual([
      {
        url: "https://example.com/keep",
        title: "Keep Title",
        description: "Keep Desc",
      },
      {
        url: "https://example.com/added-1",
      },
    ]);
    expect(order).toEqual([
      "collect:team-map-1:https://example.com:2:2",
      "finished:team-map-1:2",
    ]);
  });

  it("runs map.collect and map.finished on the avgrab early-return path and isolates observer errors", async () => {
    const seen: Array<{ id: string; urls: number; teamId: string }> = [];
    const report = installHooks({
      "map.collect": urls => urls.filter(url => !url.endsWith("/fast-2")),
      "map.finished": event => {
        seen.push({
          id: event.id,
          urls: event.urls,
          teamId: event.ctx.teamId,
        });
        throw new Error("observer failed");
      },
    });

    mocks.resolveViaAvgrab.mockResolvedValue([
      { url: "https://example.com/fast-1" },
      { url: "https://example.com/fast-2" },
    ]);

    const res = makeRes();
    await mapController(makeReq({ url: "https://example.com" }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.links).toEqual([{ url: "https://example.com/fast-1" }]);
    expect(mocks.billTeam).toHaveBeenCalledWith(
      "team-map-1",
      "org-1",
      1,
      9,
      expect.any(Object),
    );
    expect(seen).toEqual([
      {
        id: body.id,
        urls: 1,
        teamId: "team-map-1",
      },
    ]);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("propagates avgrab map.collect errors without falling back and filters collected URLs against threat policy", async () => {
    let collectCalls = 0;
    installHooks({
      "map.collect": () => {
        collectCalls += 1;
        throw new Error("avgrab collect rejected");
      },
    });
    mocks.resolveViaAvgrab.mockResolvedValue([
      { url: "https://example.com/av-1" },
    ]);

    await expect(
      mapController(makeReq({ url: "https://example.com" }), makeRes()),
    ).rejects.toThrow("avgrab collect rejected");
    expect(collectCalls).toBe(1);
    expect(mocks.fireEngineMap).not.toHaveBeenCalled();

    const finished: number[] = [];
    installHooks({
      "map.collect": urls => [...urls, "https://blocked.example/malware"],
      "map.finished": event => {
        finished.push(event.urls);
      },
    });
    mocks.resolveThreatProtection.mockResolvedValue({
      policy: { mode: "block" },
    });
    mocks.checkUrlsAgainstThreatPolicy.mockResolvedValue({
      decisionsByUrl: new Map([
        ["https://example.com/av-1", { allowed: true }],
        ["https://blocked.example/malware", { allowed: false }],
      ]),
    });

    const res = makeRes();
    await mapController(makeReq({ url: "https://example.com" }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].links).toEqual([
      { url: "https://example.com/av-1" },
    ]);
    expect(mocks.billTeam).toHaveBeenCalledWith(
      "team-map-1",
      "org-1",
      1,
      9,
      expect.any(Object),
    );
    expect(finished).toEqual([1]);
  });

  it("propagates map.collect errors and preserves identical output when unregistered", async () => {
    mocks.fireEngineMap.mockResolvedValue([
      { url: "https://example.com/a", title: "A", description: "Desc A" },
    ]);

    const withoutService = await getMapResults({
      url: "https://example.com",
      limit: 5,
      teamId: "team-map-1",
      flags: null,
      crawlerOptions: { sitemap: "skip" },
    });

    installHooks();
    const withoutHandlers = await getMapResults({
      url: "https://example.com",
      limit: 5,
      teamId: "team-map-1",
      flags: null,
      crawlerOptions: { sitemap: "skip" },
    });

    expect(withoutHandlers.mapResults).toEqual(withoutService.mapResults);

    installHooks({
      "map.collect": async () => {
        throw new Error("map vetoed");
      },
    });

    await expect(
      getMapResults({
        url: "https://example.com",
        limit: 5,
        teamId: "team-map-1",
        flags: null,
        crawlerOptions: { sitemap: "skip" },
      }),
    ).rejects.toThrow("map vetoed");
  });

  it("reapplies map scope constraints to map.collect additions and preserves titled duplicates", async () => {
    mocks.fireEngineMap.mockResolvedValue([
      { url: "https://example.com/docs/intro", title: "Intro" },
    ]);

    installHooks({
      "map.collect": () => [
        "https://example.com/docs/intro/",
        "https://example.com/docs/guide?ref=1",
        "https://other.com/docs/external",
        "https://sub.example.com/docs/sub",
        "https://example.com/blog/post",
        "javascript:alert(1)",
      ],
    });

    const scoped = await getMapResults({
      url: "https://example.com/docs",
      limit: 5,
      includeSubdomains: false,
      filterByPath: true,
      allowExternalLinks: false,
      teamId: "team-map-1",
      flags: null,
      crawlerOptions: { sitemap: "skip", ignoreQueryParameters: true },
    });

    expect(scoped.mapResults).toEqual([
      { url: "https://example.com/docs/intro", title: "Intro" },
      { url: "https://example.com/docs/guide" },
    ]);

    installHooks({
      "map.collect": urls => urls,
    });

    const deduped = await applyMapCollectHook(
      [
        { url: "https://example.com/dup" },
        { url: "https://example.com/dup", title: "Titled" },
      ],
      {
        ctx: requestContext({
          teamId: "team-map-1",
          zeroDataRetention: false,
        }),
        url: "https://example.com",
        limit: 5,
      },
    );

    expect(deduped).toEqual([
      { url: "https://example.com/dup", title: "Titled" },
    ]);
  });
});
