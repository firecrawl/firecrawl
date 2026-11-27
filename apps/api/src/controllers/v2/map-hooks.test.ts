import express from "express";
import type { Response } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { resolveRedirects as resolveRedirectsFn } from "../../lib/validateUrl";
import type { BillingModule } from "../../service/modules";

const mocks = vi.hoisted(() => {
  const crawler = {
    getRobotsTxt: vi.fn(async () => ""),
    importRobotsTxt: vi.fn(),
    tryGetSitemap: vi.fn<
      (cb: (urls: Array<string>) => void) => Promise<number>
    >(async () => 0),
  };

  return {
    crawler,
    billingCharge: vi.fn<BillingModule["charge"]>(async () => undefined),
  };
});

vi.mock("../../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock("../../lib/crawl-redis", () => ({
  crawlToCrawler: vi.fn(() => mocks.crawler),
}));

vi.mock("../../lib/validateUrl", async importOriginal => {
  const actual = await importOriginal<{
    resolveRedirects: typeof resolveRedirectsFn;
  }>();
  return {
    ...actual,
    resolveRedirects: vi.fn(async (url: string) => url),
  };
});

import { jsonRecordSchema } from "../../lib/json-types";
import type { JsonObject } from "../../lib/json-types";
import {
  applyMapCollectHook,
  applyMapFilterHook,
  getMapResults,
} from "../../lib/map-utils";
import { requestContext } from "../../lib/request-context";
import type { HookHandlers, ResponsePayload } from "../../service/hooks";
import { createService, replaceService } from "../../service/service";
import { mapController } from "./map";
import type { MapResponse } from "./types";

function installHooks(
  hooks?: HookHandlers | Array<HookHandlers>,
  report = vi.fn(),
) {
  const extensions = hooks
    ? (Array.isArray(hooks) ? hooks : [hooks]).map((h, i) => ({
        name: `test-hooks-${i}`,
        hooks: h,
      }))
    : [];
  replaceService(
    createService(
      {
        modules: {
          billing: {
            authorize: async () => ({ ok: true }),
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

async function postMap(body: JsonObject): Promise<{
  status: number;
  body: JsonObject;
}> {
  let captured: unknown;
  const app = express();
  app.use(express.json());
  app.post(
    "/v2/map",
    async (req, res: Response<MapResponse | ResponsePayload>) => {
      const originalJson = res.json.bind(res);
      res.json = (payload: MapResponse | ResponsePayload) => {
        captured = payload;
        originalJson(payload);
        return res;
      };
      const authedReq = Object.assign(req, {
        auth: { team_id: "team-map-1" },
        acuc: {
          api_key: "test-key",
          api_key_id: 9,
          team_id: "team-map-1",
          org_id: "org-1",
          flags: null,
          concurrency_limit: 10,
          rate_limit_multiplier: 1,
          is_paid_plan: false,
        },
      });
      await mapController(authedReq, res);
    },
  );
  const response = await request(app).post("/v2/map").send(body);
  return { status: response.status, body: jsonRecordSchema.parse(captured) };
}

describe("map lifecycle hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    replaceService(undefined);
    mocks.crawler.tryGetSitemap.mockResolvedValue(0);
  });

  afterEach(() => {
    replaceService(undefined);
  });

  it("runs map.collect before map.finished, transforms URLs while keeping metadata, and slices to limit", async () => {
    const order: Array<string> = [];
    let finishedId: string | undefined;
    installHooks([
      {
        "map.collect": (urls, info) => {
          info.documents?.set("https://example.com/keep", {
            url: "https://example.com/keep",
            title: "Keep Title",
            description: "Keep Desc",
          });
          info.documents?.set("https://example.com/drop", {
            url: "https://example.com/drop",
            title: "Drop Title",
            description: "Drop Desc",
          });
          return [
            ...urls,
            "https://example.com/keep",
            "https://example.com/drop",
          ];
        },
      },
      {
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
      },
    ]);

    const { status, body } = await postMap({
      url: "https://example.com",
      limit: 2,
      sitemap: "skip",
    });

    expect(status).toBe(200);
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

  it("forwards map.collect state to billing.charge and isolates map.finished observer errors", async () => {
    const finished: Array<number> = [];
    const report = installHooks([
      {
        "map.collect": urls => [
          ...urls,
          "https://example.com/safe-1",
          "https://blocked.example/malware",
        ],
        "map.finished": event => {
          finished.push(event.urls);
          throw new Error("observer failed");
        },
      },
      {
        "map.collect": (urls, info) => {
          if (info.state) {
            info.state.threatDecisions = urls.map(url => ({
              allowed: !url.includes("blocked.example"),
            }));
          }
          return urls.filter(url => !url.includes("blocked.example"));
        },
      },
    ]);

    const { status, body } = await postMap({ url: "https://example.com" });

    expect(status).toBe(200);
    expect(body.links).toEqual([{ url: "https://example.com/safe-1" }]);
    expect(mocks.billingCharge).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "map",
        urls: 1,
        ctx: expect.objectContaining({
          teamId: "team-map-1",
          orgId: "org-1",
          apiKeyId: 9,
        }),
        state: expect.objectContaining({
          threatDecisions: [{ allowed: true }, { allowed: false }],
        }),
      }),
    );
    expect(finished).toEqual([1]);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("propagates map.collect errors and preserves identical output when unregistered", async () => {
    mocks.crawler.tryGetSitemap.mockImplementation(
      async (cb: (urls: Array<string>) => void) => {
        cb(["https://example.com/a"]);
        return 1;
      },
    );

    const withoutService = await getMapResults({
      url: "https://example.com",
      limit: 5,
      teamId: "team-map-1",
      flags: null,
      crawlerOptions: { sitemap: "include" },
    });

    installHooks();
    const withoutHandlers = await getMapResults({
      url: "https://example.com",
      limit: 5,
      teamId: "team-map-1",
      flags: null,
      crawlerOptions: { sitemap: "include" },
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
        crawlerOptions: { sitemap: "include" },
      }),
    ).rejects.toThrow("map vetoed");
  });

  it("reapplies map scope constraints to map.collect additions and preserves titled duplicates", async () => {
    installHooks([
      {
        "map.collect": (urls, info) => {
          info.documents?.set("https://example.com/docs/intro", {
            url: "https://example.com/docs/intro",
            title: "Intro",
          });
          return [...urls, "https://example.com/docs/intro"];
        },
      },
      {
        "map.collect": () => [
          "https://example.com/docs/intro/",
          "https://example.com/docs/guide?ref=1",
          "https://other.com/docs/external",
          "https://sub.example.com/docs/sub",
          "https://example.com/blog/post",
          "javascript:alert(1)",
        ],
      },
    ]);

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

  it("runs map.filter after scope and limit slicing, supports skipDiscovery, and runs direct applyMapFilterHook", async () => {
    const seenByFilter: Array<Array<string>> = [];
    const collectSpy = vi.fn((urls: Array<string>) => [
      ...urls,
      "https://example.com/docs/a",
      "https://example.com/docs/b",
      "https://example.com/docs/c",
      "https://other.com/docs/out-of-scope",
    ]);
    installHooks({
      "map.collect": collectSpy,
      "map.filter": (docs, info) => {
        seenByFilter.push(docs.map(d => d.url));
        if (info.state) {
          info.state.filtered = true;
        }
        return docs.filter(d => !d.url.endsWith("/b"));
      },
    });

    const res = await getMapResults({
      url: "https://example.com/docs",
      limit: 2,
      includeSubdomains: false,
      filterByPath: true,
      allowExternalLinks: false,
      teamId: "team-map-filter",
      flags: null,
      crawlerOptions: { sitemap: "skip" },
    });

    expect(seenByFilter[0]).toEqual([
      "https://example.com/docs/a",
      "https://example.com/docs/b",
    ]);
    expect(res.mapResults).toEqual([{ url: "https://example.com/docs/a" }]);
    expect(res.state).toEqual({ filtered: true });

    collectSpy.mockClear();
    const skipped = await applyMapCollectHook(
      [
        { url: "https://example.com/docs/a" },
        { url: "https://example.com/docs/b" },
      ],
      {
        ctx: requestContext({
          teamId: "team-map-filter",
          zeroDataRetention: false,
        }),
        url: "https://example.com/docs",
        limit: 5,
        state: { skipDiscovery: true },
      },
    );
    expect(collectSpy).not.toHaveBeenCalled();
    expect(skipped).toEqual([{ url: "https://example.com/docs/a" }]);

    const direct = await applyMapFilterHook(
      [
        { url: "https://example.com/docs/a", title: "A" },
        { url: "https://example.com/docs/b", title: "B" },
      ],
      {
        ctx: requestContext({
          teamId: "team-map-filter",
          zeroDataRetention: false,
        }),
        url: "https://example.com/docs",
        limit: 5,
      },
    );
    expect(direct).toEqual([{ url: "https://example.com/docs/a", title: "A" }]);
  });
});
