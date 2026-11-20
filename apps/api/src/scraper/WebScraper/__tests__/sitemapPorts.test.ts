import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  sets: new Map<string, Set<string>>(),
  failValue: undefined as string | undefined,
}));

vi.mock("../../../services/redis", () => {
  const sadd = (key: string, value: string) => {
    const values = fake.sets.get(key) ?? new Set<string>();
    fake.sets.set(key, values);
    const added = values.has(value) ? 0 : 1;
    values.add(value);
    return added;
  };
  return {
    redisEvictConnection: {
      sadd: async (key: string, value: string) => sadd(key, value),
      expire: async () => 1,
      pipeline: () => {
        const commands: Array<() => [Error | null, number | null]> = [];
        const pipeline = {
          sadd(key: string, value: string) {
            commands.push(() =>
              value === fake.failValue
                ? [new Error("SADD failed"), null]
                : [null, sadd(key, value)],
            );
            return pipeline;
          },
          async exec() {
            return commands.map(command => command());
          },
        };
        return pipeline;
      },
    },
  };
});
vi.mock("../sitemap", () => ({ getLinksFromSitemap: vi.fn() }));
vi.mock("../../../lib/robots-txt", () => ({
  fetchRobotsTxt: vi.fn(),
  createRobotsChecker: vi.fn(),
  isUrlAllowedByRobots: vi.fn(),
}));
vi.mock("@mendable/firecrawl-rs", () => ({
  extractLinks: vi.fn(),
  filterUrl: vi.fn(),
  filterLinks: vi.fn(async ({ links }: { links: string[] }) => ({
    links,
    denialReasons: {},
    robotsBlocked: [],
  })),
}));

import { WebCrawler } from "../crawler";

beforeEach(() => {
  fake.sets.clear();
  fake.failValue = undefined;
});

async function discover(urls: string[]) {
  const crawler = new WebCrawler({
    jobId: "ports",
    initialUrl: urls[0],
    limit: 100,
  });
  // The download/XML boundary yields two sitemap batches. The public method's
  // native-filter boundary, Redis deduplication and delivery remain in the path.
  vi.spyOn(crawler as any, "tryFetchSitemapLinks").mockImplementation(
    async (_source: string, handler: (batch: string[]) => Promise<void>) => {
      await handler(urls.slice(0, 1));
      await handler(urls.slice(1));
      return urls.length;
    },
  );
  const delivered: string[] = [];
  await crawler.tryGetSitemap(batch => {
    delivered.push(...batch);
  });
  return delivered;
}

describe("sitemap URL deduplication with custom ports", () => {
  describe.each(["literal", "canonical"] as const)(
    "%s URL spelling",
    spelling => {
      it.each([80, 443, 8080, 8443])(
        "delivers HTTP and HTTPS services at port %i separately",
        async port => {
          const literalUrls = [
            `http://example.com:${port}/docs`,
            `https://example.com:${port}/docs`,
          ];
          // XML can preserve explicit default ports; canonical input also covers
          // producers that have already serialized these URLs through URL.href.
          const urls =
            spelling === "literal"
              ? literalUrls
              : literalUrls.map(url => new URL(url).href);
          expect(await discover(urls)).toEqual(urls);
        },
      );
    },
  );

  it("does not deliver a URL whose Redis set-add command fails", async () => {
    const urls = ["https://example.com/docs", "https://example.com/next"];
    fake.failValue = "example.com/next";
    expect(await discover(urls)).toEqual([urls[0]]);
  });

  it("keeps default-port protocol aliases deduplicated", async () => {
    const urls = ["http://example.com/docs", "https://example.com/docs"];
    expect(await discover(urls)).toEqual([urls[0]]);
  });

  it("keeps www and trailing-slash aliases of one custom service deduplicated", async () => {
    const urls = [
      "https://example.com:8080/docs",
      "https://www.example.com:8080/docs/",
    ];
    expect(await discover(urls)).toEqual([urls[0]]);
  });
});
