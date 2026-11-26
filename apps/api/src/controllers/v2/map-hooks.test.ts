import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const crawler = {
    getRobotsTxt: vi.fn(async (..._args: any[]) => ""),
    importRobotsTxt: vi.fn(),
    isRobotsAllowed: vi.fn((_target: string) => true),
    isFile: vi.fn((_pathname: string) => false),
    tryGetSitemap: vi.fn(async (..._args: any[]) => 0),
  };

  return {
    crawler,
    warn: vi.fn(),
    scrapeURL: vi.fn(),
    dnsLookup: vi.fn(async () => ({ address: "93.184.216.34", family: 4 })),
    billingCharge: vi.fn(
      async (..._args: any[]): Promise<number | undefined> => undefined,
    ),
  };
});

vi.mock("node:dns/promises", () => ({
  lookup: mocks.dnsLookup,
}));

vi.mock("../../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: mocks.warn,
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
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

vi.mock("../../scraper/scrapeURL", () => ({ scrapeURL: mocks.scrapeURL }));

import { config } from "../../config";
import {
  applyMapCollectHook,
  applyMapFilterHook,
  getMapResults,
} from "../../lib/map-utils";
import { requestContext } from "../../lib/request-context";
import type { HookHandlers } from "../../service/hooks";
import { createService, replaceService } from "../../service/service";
import { mapController } from "./map";

const originalPlaywrightUrl = config.PLAYWRIGHT_MICROSERVICE_URL;

function installHooks(hooks?: HookHandlers | HookHandlers[], report = vi.fn()) {
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

function makeReq(body: Record<string, any>) {
  return {
    body,
    headers: {},
    auth: { team_id: "team-map-1" },
    acuc: { api_key_id: 9, org_id: "org-1", flags: null },
  } as any;
}

function makeRes() {
  const res: any = Object.assign(new EventEmitter(), {
    destroyed: false,
    status: vi.fn(),
    json: vi.fn(),
  });
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

describe("map lifecycle hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    replaceService(undefined);
    mocks.crawler.tryGetSitemap.mockResolvedValue(0);
  });

  afterEach(() => {
    replaceService(undefined);
    (config as any).PLAYWRIGHT_MICROSERVICE_URL = originalPlaywrightUrl;
    mocks.crawler.isRobotsAllowed.mockReturnValue(true);
  });

  it.each(["completed", "failed"])(
    "records %s map work after disconnect",
    async outcome => {
      const res = makeRes();
      const error = new Error("map filter failed");
      const finished = vi.fn();
      installHooks({
        "map.filter": docs => {
          res.destroyed = true;
          res.emit("close");
          if (outcome === "failed") throw error;
          return docs;
        },
        "map.finished": finished,
      });
      await mapController(
        makeReq({ url: "https://example.com", sitemap: "skip" }),
        res,
      );
      expect(res.json).not.toHaveBeenCalled();
      if (outcome === "completed") {
        expect(mocks.billingCharge).toHaveBeenCalledTimes(1);
        expect(finished).toHaveBeenCalledTimes(1);
      } else {
        expect(mocks.warn).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ error }),
        );
        expect(mocks.billingCharge).not.toHaveBeenCalled();
        expect(finished).not.toHaveBeenCalled();
      }
    },
  );

  it("keeps start-page discovery on the requested origin for hosts without a registrable domain", async () => {
    const url = "https://catalog:8443/";
    mocks.scrapeURL.mockResolvedValueOnce({
      success: true,
      document: {
        metadata: { statusCode: 200, contentType: "text/html", url },
        links: [url + "guide", "https://catalog:9443/other"],
      },
    });
    const result = await getMapResults({
      url,
      limit: 5,
      teamId: "team-map-1",
      flags: null,
      crawlerOptions: { sitemap: "include" },
      startPageDiscovery: true,
    });
    expect(result.mapResults.map(link => link.url)).toEqual([url + "guide"]);
    expect(mocks.crawler.getRobotsTxt).toHaveBeenCalledTimes(1);
  });

  it("runs map.collect before map.finished, transforms URLs while keeping metadata, and slices to limit", async () => {
    const order: string[] = [];
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

  it("forwards map.collect state to billing.charge and isolates map.finished observer errors", async () => {
    const finished: number[] = [];
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

    const res = makeRes();
    await mapController(makeReq({ url: "https://example.com" }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
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
      async (cb: (urls: string[]) => void) => {
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
    const seenByFilter: string[][] = [];
    const collectSpy = vi.fn((urls: string[]) => [
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

  it("retries WAF 403 start-page fetches with Playwright while keeping 404 single-attempt", async () => {
    (config as any).PLAYWRIGHT_MICROSERVICE_URL =
      "http://playwright.local/scrape";

    mocks.scrapeURL
      .mockResolvedValueOnce({
        success: true,
        document: {
          metadata: {
            statusCode: 403,
            contentType: "text/html",
            url: "https://waf.example.com/",
          },
          rawHtml: "<html><title>Attention Required!</title></html>",
          links: [],
        },
      })
      .mockResolvedValueOnce({
        success: true,
        document: {
          metadata: {
            statusCode: 200,
            contentType: "text/html",
            url: "https://waf.example.com/",
          },
          rawHtml:
            "<html><body><a href='https://waf.example.com/pricing'>Pricing</a></body></html>",
          links: [
            "https://waf.example.com/pricing",
            "https://waf.example.com/cdn-cgi/l/email-protection",
          ],
        },
      });

    installHooks();
    const res = Object.assign(makeRes(), { setHeader: vi.fn() });
    await mapController(makeReq({ url: "https://waf.example.com" }), res);

    expect(mocks.scrapeURL).toHaveBeenCalledTimes(2);
    expect(mocks.scrapeURL.mock.calls[0][2].headers?.["User-Agent"]).toContain(
      "Mozilla/5.0",
    );
    expect(mocks.scrapeURL.mock.calls[0][3].forceEngine).toBe("fetch");
    expect(
      mocks.scrapeURL.mock.calls[1][2].headers?.["User-Agent"],
    ).toBeUndefined();
    expect(mocks.scrapeURL.mock.calls[1][3].forceEngine).toBe("playwright");

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].links).toEqual([
      { url: "https://waf.example.com/pricing" },
    ]);
    expect(res.setHeader).toHaveBeenCalledWith(
      "X-Firecrawl-Map-Outcome",
      "links_found",
    );
    expect(res.setHeader).toHaveBeenCalledWith(
      "X-Firecrawl-Map-Status-Code",
      "200",
    );

    vi.clearAllMocks();
    mocks.crawler.tryGetSitemap.mockResolvedValue(0);
    mocks.scrapeURL.mockResolvedValueOnce({
      success: true,
      document: {
        metadata: {
          statusCode: 404,
          contentType: "text/html",
          url: "https://missing.example.com/",
        },
        rawHtml: "<html><body>Not Found</body></html>",
        links: [],
      },
    });

    const missing = await getMapResults({
      url: "https://missing.example.com",
      limit: 5,
      teamId: "team-map-1",
      flags: null,
      crawlerOptions: { sitemap: "include" },
      startPageDiscovery: true,
    });
    expect(mocks.scrapeURL).toHaveBeenCalledTimes(1);
    expect(missing.mapResults).toEqual([]);
    expect(missing.discovery).toEqual({
      outcome: "http_not_found",
      statusCode: 404,
      landedUrl: "https://missing.example.com/",
    });
  });

  it("ignores /cdn-cgi/ and /_next/ utility links and distinguishes verified single pages from challenge pages", async () => {
    (config as any).PLAYWRIGHT_MICROSERVICE_URL =
      "http://playwright.local/scrape";

    mocks.scrapeURL
      .mockResolvedValueOnce({
        success: true,
        document: {
          metadata: {
            statusCode: 200,
            contentType: "text/html",
            url: "https://spa.example.com/",
          },
          rawHtml: "<html><body><div id='root'></div></body></html>",
          links: [
            "https://spa.example.com/cdn-cgi/l/email-protection",
            "https://spa.example.com/_next/static/chunks/main.js",
          ],
        },
      })
      .mockResolvedValueOnce({
        success: true,
        document: {
          metadata: {
            statusCode: 200,
            contentType: "text/html",
            url: "https://spa.example.com/",
            title: "Acme Robotics",
          },
          rawHtml:
            "<html><body><main>Acme Robotics builds autonomous warehouse picking systems for industrial logistics hubs across North America and Europe with zero subpages.</main></body></html>",
          links: [],
        },
      });

    const singlePage = await getMapResults({
      url: "https://spa.example.com",
      limit: 5,
      teamId: "team-map-1",
      flags: null,
      crawlerOptions: { sitemap: "include" },
      startPageDiscovery: true,
    });
    expect(mocks.scrapeURL).toHaveBeenCalledTimes(2);
    expect(singlePage.mapResults).toEqual([]);
    expect(singlePage.discovery).toEqual({
      outcome: "verified_single_page",
      statusCode: 200,
      landedUrl: "https://spa.example.com",
    });

    vi.clearAllMocks();
    mocks.crawler.tryGetSitemap.mockResolvedValue(0);
    mocks.scrapeURL
      .mockResolvedValueOnce({
        success: true,
        document: {
          metadata: {
            statusCode: 403,
            contentType: "text/html",
            url: "https://walled.example.com/",
          },
          rawHtml: "<html><title>Just a moment...</title></html>",
          links: [],
        },
      })
      .mockResolvedValueOnce({
        success: true,
        document: {
          metadata: {
            statusCode: 200,
            contentType: "text/html",
            url: "https://walled.example.com/",
            title: "Just a moment...",
          },
          rawHtml:
            "<html><body>Verify you are human before continuing to walled.example.com security check page for browser verification challenge.</body></html>",
          links: [],
        },
      });

    const challenged = await getMapResults({
      url: "https://walled.example.com",
      limit: 5,
      teamId: "team-map-1",
      flags: null,
      crawlerOptions: { sitemap: "include" },
      startPageDiscovery: true,
    });
    expect(challenged.discovery?.outcome).toBe("blocked_or_challenge");
  });

  it("adopts cross-domain start-page redirect scope with destination robots.txt and isolates PSL tenants", async () => {
    mocks.crawler.isRobotsAllowed.mockImplementation(
      (target: string) => !target.endsWith("/private"),
    );
    mocks.scrapeURL.mockResolvedValueOnce({
      success: true,
      document: {
        metadata: {
          statusCode: 200,
          contentType: "text/html",
          url: "https://onefactor.ai/",
        },
        rawHtml: "<html><body>OneFactor</body></html>",
        links: [
          "https://onefactor.ai/about",
          "https://onefactor.ai/private",
          "https://unrelated.io/page",
        ],
      },
    });

    const redirected = await getMapResults({
      url: "https://kallaway.co",
      limit: 5,
      teamId: "team-map-1",
      flags: null,
      crawlerOptions: { sitemap: "include" },
      startPageDiscovery: true,
    });
    expect(redirected.mapResults).toEqual([
      { url: "https://onefactor.ai/about" },
    ]);
    expect(redirected.discovery?.outcome).toBe("links_found");
    expect(mocks.crawler.getRobotsTxt).toHaveBeenCalledTimes(2);

    vi.clearAllMocks();
    mocks.crawler.tryGetSitemap.mockResolvedValue(0);
    mocks.crawler.isRobotsAllowed.mockReturnValue(true);
    mocks.scrapeURL.mockResolvedValueOnce({
      success: true,
      document: {
        metadata: {
          statusCode: 200,
          contentType: "text/html",
          url: "https://norelix.vercel.app/",
        },
        rawHtml: "<html><body>Norelix</body></html>",
        links: [
          "https://norelix.vercel.app/docs",
          "https://other-tenant.vercel.app/docs",
        ],
      },
    });

    const pslScoped = await getMapResults({
      url: "https://norelix.vercel.app",
      limit: 5,
      teamId: "team-map-1",
      flags: null,
      crawlerOptions: { sitemap: "include" },
      startPageDiscovery: true,
    });
    expect(pslScoped.mapResults).toEqual([
      { url: "https://norelix.vercel.app/docs" },
    ]);
  });

  it("aborts sitemap recursion early once limit in-scope URLs arrive", async () => {
    let signalAfterFirstBatch = false;
    mocks.crawler.tryGetSitemap.mockImplementationOnce(
      async (
        urlsHandler: (urls: string[]) => void,
        _fromMap?: boolean,
        _only?: boolean,
        _timeout?: number,
        abortSignal?: AbortSignal,
      ) => {
        urlsHandler([
          "https://example.com/p1",
          "https://example.com/p2",
          "https://example.com/p3",
        ]);
        signalAfterFirstBatch = Boolean(abortSignal?.aborted);
        return 3;
      },
    );

    const capped = await getMapResults({
      url: "https://example.com",
      limit: 2,
      teamId: "team-map-1",
      flags: null,
      crawlerOptions: { sitemap: "include" },
      startPageDiscovery: true,
    });
    expect(signalAfterFirstBatch).toBe(true);
    expect(capped.mapResults).toEqual([
      { url: "https://example.com/p1" },
      { url: "https://example.com/p2" },
    ]);
    expect(capped.discovery?.outcome).toBe("links_found");
    expect(mocks.scrapeURL).not.toHaveBeenCalled();
  });

  it("ignores utility sitemap links before limit during discovery while preserving them for search, and drops late sitemap callbacks", async () => {
    (config as any).PLAYWRIGHT_MICROSERVICE_URL =
      "http://playwright.local/scrape";

    let lateCallback: ((urls: string[]) => void) | undefined;
    mocks.crawler.tryGetSitemap.mockImplementationOnce(
      async (urlsHandler: (urls: string[]) => void) => {
        lateCallback = urlsHandler;
        urlsHandler([
          "https://spa.example.com/_next/static/chunk-a.js",
          "https://spa.example.com/cdn-cgi/l/email-protection",
        ]);
        return 2;
      },
    );
    mocks.scrapeURL
      .mockResolvedValueOnce({
        success: true,
        document: {
          metadata: {
            statusCode: 200,
            contentType: "text/html",
            url: "https://spa.example.com/",
          },
          rawHtml: "<html><body></body></html>",
          links: [],
        },
      })
      .mockResolvedValueOnce({
        success: true,
        document: {
          metadata: {
            statusCode: 200,
            contentType: "text/html",
            url: "https://spa.example.com/",
          },
          rawHtml:
            "<html><body><a href='/docs'>Docs</a><a href='/pricing'>Pricing</a></body></html>",
          links: [
            "https://spa.example.com/docs",
            "https://spa.example.com/pricing",
          ],
        },
      });

    const recovered = await getMapResults({
      url: "https://spa.example.com",
      limit: 2,
      teamId: "team-map-1",
      flags: null,
      crawlerOptions: { sitemap: "include" },
      startPageDiscovery: true,
    });
    lateCallback?.([
      "https://evil.example.org/leaked",
      "https://spa.example.com/extra-1",
      "https://spa.example.com/extra-2",
    ]);
    expect(mocks.scrapeURL).toHaveBeenCalledTimes(2);
    expect(recovered.mapResults).toEqual([
      { url: "https://spa.example.com/docs" },
      { url: "https://spa.example.com/pricing" },
    ]);
    expect(recovered.discovery?.outcome).toBe("links_found");

    vi.clearAllMocks();
    mocks.crawler.tryGetSitemap.mockImplementationOnce(
      async (urlsHandler: (urls: string[]) => void) => {
        urlsHandler([
          "https://spa.example.com/_next/static/chunk-a.js",
          "https://spa.example.com/cdn-cgi/l/email-protection",
        ]);
        return 2;
      },
    );
    const searched = await getMapResults({
      url: "https://spa.example.com",
      search: "chunk-a",
      limit: 5,
      teamId: "team-map-1",
      flags: null,
      crawlerOptions: { sitemap: "include" },
      startPageDiscovery: true,
    });
    expect(mocks.scrapeURL).not.toHaveBeenCalled();
    expect(searched.mapResults.map(x => x.url)).toContain(
      "https://spa.example.com/_next/static/chunk-a.js",
    );
  });

  it("stops at unsupported_file for headerless file URLs without retrying in Playwright", async () => {
    (config as any).PLAYWRIGHT_MICROSERVICE_URL =
      "http://playwright.local/scrape";
    mocks.crawler.tryGetSitemap.mockResolvedValue(0);
    mocks.crawler.isFile.mockImplementation((p: string) => p.endsWith(".pdf"));
    mocks.scrapeURL.mockResolvedValueOnce({
      success: true,
      document: {
        metadata: {
          statusCode: 200,
          contentType: undefined,
          url: "https://files.example.com/whitepaper.pdf",
        },
        rawHtml: "%PDF-1.7",
        links: [],
      },
    });
    const fileRes = await getMapResults({
      url: "https://files.example.com/whitepaper.pdf",
      limit: 5,
      teamId: "team-map-1",
      flags: null,
      crawlerOptions: { sitemap: "include" },
      startPageDiscovery: true,
    });
    expect(mocks.scrapeURL).toHaveBeenCalledTimes(1);
    expect(fileRes.discovery?.outcome).toBe("unsupported_file");
    mocks.crawler.isFile.mockReturnValue(false);
  });

  it("does not claim verified_single_page for sub-path start URLs without child links", async () => {
    (config as any).PLAYWRIGHT_MICROSERVICE_URL =
      "http://playwright.local/scrape";
    mocks.crawler.tryGetSitemap.mockResolvedValue(0);
    mocks.scrapeURL
      .mockResolvedValueOnce({
        success: true,
        document: {
          metadata: {
            statusCode: 200,
            contentType: "text/html",
            url: "https://subpath.example.com/pricing",
          },
          rawHtml: "<html><body></body></html>",
          links: [],
        },
      })
      .mockResolvedValueOnce({
        success: true,
        document: {
          metadata: {
            statusCode: 200,
            contentType: "text/html",
            url: "https://subpath.example.com/pricing",
            title: "Pricing",
          },
          rawHtml:
            "<html><body><main>Enterprise pricing details for warehouse automation deployments across North America and Europe with annual contracts.</main></body></html>",
          links: ["https://subpath.example.com/about"],
        },
      });
    const subPathRes = await getMapResults({
      url: "https://subpath.example.com/pricing",
      limit: 5,
      teamId: "team-map-1",
      flags: null,
      crawlerOptions: { sitemap: "include" },
      startPageDiscovery: true,
    });
    expect(subPathRes.discovery?.outcome).toBe("blocked_or_challenge");
  });

  it("reports timeout instead of robots_disallowed when robots.txt aborts", async () => {
    (config as any).PLAYWRIGHT_MICROSERVICE_URL =
      "http://playwright.local/scrape";
    mocks.crawler.tryGetSitemap.mockResolvedValue(0);
    const abortCtrl = new AbortController();
    mocks.crawler.getRobotsTxt
      .mockResolvedValueOnce("")
      .mockImplementationOnce(async () => {
        abortCtrl.abort(new Error("timed out"));
        throw new Error("aborted");
      });
    mocks.scrapeURL.mockResolvedValueOnce({
      success: true,
      document: {
        metadata: {
          statusCode: 200,
          contentType: "text/html",
          url: "https://redirected.example.org/",
        },
        rawHtml: "<html><body><a href='/team'>Team</a></body></html>",
        links: ["https://redirected.example.org/team"],
      },
    });
    const abortedRobots = await getMapResults({
      url: "https://origin.example.com",
      limit: 5,
      teamId: "team-map-1",
      flags: null,
      abort: abortCtrl.signal,
      crawlerOptions: { sitemap: "include" },
      startPageDiscovery: true,
    });
    expect(abortedRobots.discovery?.outcome).toBe("timeout");
  });

  it("treats transient EAI_AGAIN DNS lookup failures as blocked_or_challenge rather than dns_error", async () => {
    (config as any).PLAYWRIGHT_MICROSERVICE_URL =
      "http://playwright.local/scrape";
    mocks.dnsLookup.mockReset();
    mocks.crawler.tryGetSitemap.mockResolvedValue(0);
    const eaiAgain = Object.assign(
      new Error("getaddrinfo EAI_AGAIN transient.example.com"),
      { code: "EAI_AGAIN" },
    );
    mocks.dnsLookup.mockRejectedValue(eaiAgain);
    mocks.scrapeURL
      .mockResolvedValueOnce({
        success: false,
        error: { code: "SCRAPE_ALL_ENGINES_FAILED", message: "fetch failed" },
      })
      .mockResolvedValueOnce({
        success: false,
        error: { code: "SCRAPE_ALL_ENGINES_FAILED", message: "fetch failed" },
      });
    const transientDns = await getMapResults({
      url: "https://transient.example.com",
      limit: 5,
      teamId: "team-map-1",
      flags: null,
      crawlerOptions: { sitemap: "include" },
      startPageDiscovery: true,
    });
    expect(mocks.dnsLookup).toHaveBeenCalledWith("transient.example.com");
    expect(transientDns.discovery?.outcome).toBe("blocked_or_challenge");
    mocks.dnsLookup.mockReset();
  });

  it("bounds hung dnsLookup calls to the remaining discovery deadline and reports timeout", async () => {
    (config as any).PLAYWRIGHT_MICROSERVICE_URL =
      "http://playwright.local/scrape";
    mocks.dnsLookup.mockReset();
    mocks.crawler.tryGetSitemap.mockResolvedValue(0);
    mocks.dnsLookup.mockImplementationOnce(() => new Promise(() => {}));
    mocks.scrapeURL.mockResolvedValueOnce({
      success: false,
      error: { code: "SCRAPE_ALL_ENGINES_FAILED", message: "fetch failed" },
    });
    const t0 = Date.now();
    const boundedDns = await getMapResults({
      url: "https://hung-dns.example.com",
      limit: 5,
      teamId: "team-map-1",
      flags: null,
      crawlerOptions: { sitemap: "include", timeout: 1_600 },
      startPageDiscovery: true,
    });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(mocks.scrapeURL).toHaveBeenCalledTimes(1);
    expect(boundedDns.discovery?.outcome).toBe("timeout");
  });
});
