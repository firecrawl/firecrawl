import http from "node:http";
import { describe, expect } from "vitest";
import {
  ALLOW_TEST_SUITE_WEBSITE,
  concurrentIf,
  describeIf,
  HAS_PROXY,
  TEST_SELF_HOST,
  TEST_SUITE_WEBSITE,
} from "../lib";
import { crawl, crawlErrors, Identity, idmux, scrapeTimeout } from "./lib";

// The test site's robots.txt disallows /robots-test/blocked/. The
// /robots-test/ page is allowed and links to the blocked page.
const ROBOTS_TEST_URL = TEST_SUITE_WEBSITE + "/robots-test/";
const ROBOTS_BLOCKED_URL = TEST_SUITE_WEBSITE + "/robots-test/blocked/";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "crawl-robots",
    concurrency: 20,
    credits: 1000000,
  });
}, 10000);

const isBlockedUrl = (url: string) => url.includes("/robots-test/blocked");

describe("Crawl robots.txt reporting", () => {
  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "reports a start URL that robots.txt disallows",
    async () => {
      const results = await crawl(
        { url: ROBOTS_BLOCKED_URL, limit: 5 },
        identity,
        false,
      );

      expect(results.status).not.toBe("scraping");
      expect(results.warning ?? "").toContain("robots.txt");
      expect(results.warning ?? "").toContain("robotsBlocked");
      expect(
        (await crawlErrors(results.id, identity)).robotsBlocked.some(
          isBlockedUrl,
        ),
      ).toBe(true);
    },
    5 * scrapeTimeout,
  );

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "reports a discovered link that robots.txt disallows",
    async () => {
      const results = await crawl({ url: ROBOTS_TEST_URL, limit: 5 }, identity);

      expect(results.data.some(d => isBlockedUrl(d.metadata?.url ?? ""))).toBe(
        false,
      );
      expect(results.warning).toContain("robots.txt");
      expect(results.warning).toContain("robotsBlocked");
      expect(
        (await crawlErrors(results.id, identity)).robotsBlocked.some(
          isBlockedUrl,
        ),
      ).toBe(true);
    },
    5 * scrapeTimeout,
  );

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "does not warn when robots.txt allows every crawled page",
    async () => {
      const results = await crawl(
        { url: TEST_SUITE_WEBSITE, limit: 3 },
        identity,
      );

      expect(results.warning ?? "").not.toContain("robots.txt");
      expect((await crawlErrors(results.id, identity)).robotsBlocked).toEqual(
        [],
      );
    },
    5 * scrapeTimeout,
  );
});

// A local site whose robots.txt disallows /blocked/, so the tests can count
// the requests a crawl makes. Proxies and remote engines cannot reach it.
describeIf(TEST_SELF_HOST && !HAS_PROXY)("Crawl robots.txt requests", () => {
  const LINKS: Record<string, string[]> = {
    "/allowed/start/": ["/blocked/from-allowed/"],
    "/allowed/redirect-links/": ["/redirect/discovered/"],
    "/blocked/redirect-target/": ["/allowed/behind-redirect/"],
  };
  const REDIRECTS: Record<string, string> = {
    "/redirect/start/": "/blocked/redirect-target/",
    "/redirect/discovered/": "/blocked/discovered-target/",
  };

  const hits = new Map<string, number>();
  const hitsFor = (path: string) => hits.get(path) ?? 0;
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://fixture").pathname;
      hits.set(path, hitsFor(path) + 1);

      if (path === "/robots.txt") {
        res.setHeader("Content-Type", "text/plain");
        res.end("User-agent: *\nDisallow: /blocked/\n");
      } else if (path === "/sitemap.xml") {
        const locs = ["/allowed/from-sitemap/", "/blocked/from-sitemap/"];
        res.setHeader("Content-Type", "application/xml");
        res.end(
          `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs.map(loc => `<url><loc>${base}${loc}</loc></url>`).join("")}</urlset>`,
        );
      } else if (REDIRECTS[path]) {
        res.writeHead(302, { Location: REDIRECTS[path] });
        res.end();
      } else {
        const links = (LINKS[path] ?? [])
          .map(link => `<a href="${link}">${link}</a>`)
          .join("");
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(
          `<html><head><title>${path}</title></head><body><h1>${path}</h1>${links}</body></html>`,
        );
      }
    });

    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Failed to start the robots.txt fixture site");
    }
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });

  const robotsBlockedPaths = async (crawlId: string) =>
    (await crawlErrors(crawlId, identity)).robotsBlocked.map(
      url => new URL(url).pathname,
    );
  const crawledPaths = (data: { metadata?: { url?: string } }[]) =>
    data.map(doc => new URL(doc.metadata?.url ?? base).pathname);

  it.concurrent(
    "never requests a start URL that robots.txt disallows",
    async () => {
      const results = await crawl(
        { url: base + "/blocked/start/", limit: 5, sitemap: "skip" },
        identity,
        false,
      );

      expect(hitsFor("/blocked/start/")).toBe(0);
      expect(results.data).toEqual([]);
      expect(results.warning ?? "").toContain("robotsBlocked");
      expect(await robotsBlockedPaths(results.id)).toContain("/blocked/start/");
    },
    5 * scrapeTimeout,
  );

  it.concurrent(
    "crawls an allowed start URL without requesting the link robots.txt disallows",
    async () => {
      const results = await crawl(
        {
          url: base + "/allowed/start/",
          limit: 5,
          sitemap: "skip",
          crawlEntireDomain: true,
        },
        identity,
      );

      expect(hitsFor("/allowed/start/")).toBeGreaterThan(0);
      expect(crawledPaths(results.data)).toEqual(["/allowed/start/"]);
      expect(hitsFor("/blocked/from-allowed/")).toBe(0);
      expect(await robotsBlockedPaths(results.id)).toContain(
        "/blocked/from-allowed/",
      );
    },
    5 * scrapeTimeout,
  );

  it.concurrent(
    "records the disallowed redirect target of a start URL and crawls nothing from it",
    async () => {
      const results = await crawl(
        {
          url: base + "/redirect/start/",
          limit: 5,
          sitemap: "skip",
          crawlEntireDomain: true,
        },
        identity,
        false,
      );
      const blocked = await robotsBlockedPaths(results.id);

      expect(hitsFor("/redirect/start/")).toBeGreaterThan(0);
      expect(blocked).toContain("/blocked/redirect-target/");
      expect(blocked).not.toContain("/redirect/start/");
      expect(results.data).toEqual([]);
      expect(hitsFor("/allowed/behind-redirect/")).toBe(0);
    },
    5 * scrapeTimeout,
  );

  it.concurrent(
    "records the disallowed redirect target of a discovered link",
    async () => {
      const results = await crawl(
        {
          url: base + "/allowed/redirect-links/",
          limit: 5,
          sitemap: "skip",
          crawlEntireDomain: true,
        },
        identity,
      );
      const blocked = await robotsBlockedPaths(results.id);

      expect(hitsFor("/redirect/discovered/")).toBeGreaterThan(0);
      expect(blocked).toContain("/blocked/discovered-target/");
      expect(blocked).not.toContain("/redirect/discovered/");
      expect(crawledPaths(results.data)).toEqual(["/allowed/redirect-links/"]);
    },
    5 * scrapeTimeout,
  );

  it.concurrent(
    "records a sitemap URL that robots.txt disallows without requesting it",
    async () => {
      const results = await crawl({ url: base + "/", limit: 5 }, identity);

      expect(hitsFor("/allowed/from-sitemap/")).toBeGreaterThan(0);
      expect(hitsFor("/blocked/from-sitemap/")).toBe(0);
      expect(await robotsBlockedPaths(results.id)).toContain(
        "/blocked/from-sitemap/",
      );
    },
    5 * scrapeTimeout,
  );
});
