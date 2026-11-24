import http from "node:http";
import { describe, expect } from "vitest";
import { describeIf, HAS_PROXY, TEST_SELF_HOST } from "../lib";
import { Identity, idmux, map, scrapeTimeout } from "./lib";
import { map as mapV1 } from "../v1/lib";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "map-sitemap",
    concurrency: 20,
    credits: 1000000,
  });
}, 10000);

const urlset = (urls: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map(u => `<url><loc>${u}</loc></url>`).join("")}</urlset>`;

const sitemapindex = (urls: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map(u => `<sitemap><loc>${u}</loc></sitemap>`).join("")}</sitemapindex>`;

type Site = {
  base: string;
  hits: (path: string) => number;
  maxInFlight: () => number;
  close: () => Promise<void>;
};

async function serveSite(
  routes: (base: string) => Record<string, string>,
  delayMs: (path: string) => number = () => 0,
): Promise<Site> {
  const hits = new Map<string, number>();
  let inFlight = 0;
  let maxInFlight = 0;
  let base = "";
  const server = http.createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://fixture").pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    setTimeout(() => {
      inFlight--;
      const body = routes(base)[path];
      if (body === undefined) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found");
      } else if (path === "/robots.txt") {
        res.setHeader("Content-Type", "text/plain");
        res.end(body);
      } else if (path.endsWith("/")) {
        res.setHeader("Content-Type", "text/html");
        res.end(body);
      } else {
        res.setHeader("Content-Type", "application/xml");
        res.end(body);
      }
    }, delayMs(path));
  });

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Failed to start the sitemap fixture site");
  }
  base = `http://127.0.0.1:${address.port}`;

  return {
    base,
    hits: path => hits.get(path) ?? 0,
    maxInFlight: () => maxInFlight,
    close: async () => {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

const mapPaths = async (
  base: string,
  options: { timeout?: number; limit?: number } = {},
) => {
  const response = await map(
    {
      url: base,
      sitemap: "only",
      limit: 100000,
      ignoreCache: true,
      ...options,
    },
    identity,
  );
  expect(response.statusCode).toBe(200);
  expect(response.body.success).toBe(true);
  return {
    paths: (response.body.links as { url: string }[]).map(
      x => new URL(x.url).pathname,
    ),
    warning: response.body.warning as string | undefined,
  };
};

const indexRoutes =
  (children: number, urlsPerChild = 1) =>
  (base: string) => {
    const ns = Array.from({ length: children }, (_, i) => i + 1);
    return {
      "/robots.txt": `User-agent: *\nAllow: /\n`,
      "/sitemap.xml": sitemapindex(ns.map(n => `${base}/sitemap-${n}.xml`)),
      ...Object.fromEntries(
        ns.map(n => [
          `/sitemap-${n}.xml`,
          urlset(
            Array.from({ length: urlsPerChild }, (_, j) =>
              j === 0 ? `${base}/page-${n}` : `${base}/page-${n}-${j}`,
            ),
          ),
        ]),
      ),
    };
  };

const childHits = (site: Site, children: number) =>
  Array.from({ length: children }, (_, i) => i + 1).reduce(
    (total, n) => total + site.hits(`/sitemap-${n}.xml`),
    0,
  );

// Proxies and remote engines cannot reach a site on 127.0.0.1.
describeIf(TEST_SELF_HOST && !HAS_PROXY)("Map sitemap discovery", () => {
  it.concurrent(
    "reads a robots.txt sitemap URL that has no .xml extension",
    async () => {
      const site = await serveSite(base => ({
        "/robots.txt": `User-agent: *\nAllow: /\nSitemap: ${base}/sitemap\n`,
        "/sitemap": urlset([`${base}/people/a`, `${base}/people/b`]),
      }));
      try {
        const { paths } = await mapPaths(site.base);

        expect(paths).toContain("/people/a");
        expect(paths).toContain("/people/b");
        expect(site.hits("/sitemap/sitemap.xml")).toBe(0);
      } finally {
        await site.close();
      }
    },
    5 * scrapeTimeout,
  );

  it.concurrent(
    "reads every child of a 66-sitemap index, at most 25 at a time",
    async () => {
      const site = await serveSite(indexRoutes(66), () => 200);
      try {
        const { paths, warning } = await mapPaths(site.base);

        expect(warning).toBeUndefined();
        expect(paths).toContain("/page-1");
        expect(paths).toContain("/page-66");
        expect(paths.filter(p => p.startsWith("/page-")).length).toBe(66);
        expect(site.maxInFlight()).toBeLessThanOrEqual(25);
      } finally {
        await site.close();
      }
    },
    5 * scrapeTimeout,
  );

  it.concurrent(
    "returns no links when the robots.txt sitemap URL is missing",
    async () => {
      const site = await serveSite(base => ({
        "/robots.txt": `User-agent: *\nAllow: /\nSitemap: ${base}/sitemap\n`,
      }));
      try {
        const { paths } = await mapPaths(site.base);

        expect(paths).toEqual([]);
        expect(site.hits("/sitemap")).toBe(1);
      } finally {
        await site.close();
      }
    },
    5 * scrapeTimeout,
  );

  it.concurrent(
    "falls back to /sitemap.xml under a directory-style robots.txt sitemap URL",
    async () => {
      const site = await serveSite(base => ({
        "/robots.txt": `User-agent: *\nAllow: /\nSitemap: ${base}/en/\n`,
        "/en/": "<html><body>home</body></html>",
        "/en/sitemap.xml": urlset([`${base}/en/a`, `${base}/en/b`]),
      }));
      try {
        const { paths } = await mapPaths(site.base);

        expect(paths).toContain("/en/a");
        expect(paths).toContain("/en/b");
      } finally {
        await site.close();
      }
    },
    5 * scrapeTimeout,
  );

  it.concurrent(
    "returns partial results with a warning instead of a 408 when slow sitemaps outlast the timeout",
    async () => {
      const site = await serveSite(indexRoutes(66), path =>
        path.startsWith("/sitemap-") ? 1000 : 0,
      );
      try {
        const { paths, warning } = await mapPaths(site.base, {
          timeout: 2500,
        });

        expect(paths).toContain("/page-1");
        expect(warning).toContain("stopped at the timeout");
      } finally {
        await site.close();
      }
    },
    5 * scrapeTimeout,
  );

  it.concurrent(
    "warns when a sitemap index has more children than the 100-file limit",
    async () => {
      const site = await serveSite(indexRoutes(120));
      try {
        const { paths, warning } = await mapPaths(site.base);

        expect(paths).toContain("/page-1");
        expect(paths).not.toContain("/page-120");
        expect(warning).toContain("100-file limit");
      } finally {
        await site.close();
      }
    },
    5 * scrapeTimeout,
  );

  it.concurrent(
    "returns a 408 when no sitemap finishes before the timeout",
    async () => {
      const site = await serveSite(indexRoutes(5), path =>
        path.startsWith("/sitemap-") ? 5000 : 0,
      );
      try {
        const response = await map(
          {
            url: site.base,
            sitemap: "only",
            limit: 100000,
            ignoreCache: true,
            timeout: 2000,
          },
          identity,
        );

        expect(response.statusCode).toBe(408);
        expect(response.body.code).toBe("MAP_TIMEOUT");
      } finally {
        await site.close();
      }
    },
    5 * scrapeTimeout,
  );

  it.concurrent(
    "stops fetching sitemaps once it has twice the requested limit",
    async () => {
      const site = await serveSite(indexRoutes(120, 100), path =>
        path.startsWith("/sitemap-") ? 200 : 0,
      );
      try {
        const { paths, warning } = await mapPaths(site.base, { limit: 50 });

        expect(paths.length).toBe(50);
        expect(warning).toBeUndefined();
        expect(childHits(site, 120)).toBeLessThanOrEqual(25);
      } finally {
        await site.close();
      }
    },
    5 * scrapeTimeout,
  );

  it.concurrent(
    "does not warn when exactly 100 sitemap files are read and robots.txt repeats them",
    async () => {
      const site = await serveSite(base => ({
        ...indexRoutes(99)(base),
        "/robots.txt": `User-agent: *\nAllow: /\n${[
          "/sitemap.xml",
          "/sitemap-1.xml",
          "/sitemap-2.xml",
          "/sitemap-3.xml",
        ]
          .map(path => `Sitemap: ${base}${path}`)
          .join("\n")}\n`,
      }));
      try {
        const { paths, warning } = await mapPaths(site.base);

        expect(paths.filter(p => p.startsWith("/page-")).length).toBe(99);
        expect(warning).toBeUndefined();
      } finally {
        await site.close();
      }
    },
    5 * scrapeTimeout,
  );

  it.concurrent(
    "keeps v1 sitemapOnly at 25 sitemap files",
    async () => {
      const site = await serveSite(indexRoutes(66));
      try {
        const response = await mapV1(
          { url: site.base, sitemapOnly: true, limit: 5000 },
          identity,
        );

        expect(response.statusCode).toBe(200);
        const pages = (response.body.links as string[]).filter(link =>
          new URL(link).pathname.startsWith("/page-"),
        );
        expect(pages.length).toBe(24);
      } finally {
        await site.close();
      }
    },
    5 * scrapeTimeout,
  );
});
