import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ sets: new Map<string, Set<string>>() }));

vi.mock("../services/redis", () => ({
  redisEvictConnection: {
    pipeline: () => {
      const commands: Array<() => number> = [];
      const pipeline = {
        sadd(key: string, value: string) {
          commands.push(() => {
            const values = fake.sets.get(key) ?? new Set<string>();
            fake.sets.set(key, values);
            const added = values.has(value) ? 0 : 1;
            values.add(value);
            return added;
          });
          return pipeline;
        },
        expire() {
          commands.push(() => 1);
          return pipeline;
        },
        async exec() {
          return commands.map(command => [null, command()]);
        },
      };
      return pipeline;
    },
  },
}));
vi.mock("../scraper/WebScraper/crawler", () => ({ WebCrawler: class {} }));
vi.mock("./zdr-helpers", () => ({
  getScrapeZDR: () => undefined,
  getIgnoreRobots: () => false,
}));
vi.mock("./safe-mode", () => ({ resolveSafeMode: () => undefined }));
vi.mock("./us-only", () => ({ isUsOnly: () => false }));
vi.mock("./otel-tracer", () => ({
  withSpan: (_name: string, fn: (span: unknown) => unknown) => fn({}),
  setSpanAttributes: () => {},
}));

import { generateURLPermutations, lockURL } from "./crawl-redis";

const crawl = {
  crawlerOptions: { deduplicateSimilarURLs: true },
  scrapeOptions: {},
  internalOptions: {},
  team_id: "test",
  createdAt: 0,
} as any;

beforeEach(() => fake.sets.clear());

describe("non-default ports in crawl URL deduplication", () => {
  it.each([
    "https://example.com:80/docs",
    "http://example.com:443/docs",
    "https://example.com:8080/docs?query=1",
    "http://example.com:8080/docs?query=1",
  ])("keeps the service origin in every alias of %s", input => {
    const original = new URL(input);
    const aliases = generateURLPermutations(input);
    expect(aliases.length).toBeGreaterThan(0);
    for (const alias of aliases) {
      expect(alias.protocol).toBe(original.protocol);
      expect(alias.port).toBe(original.port);
      expect(alias.search).toBe(original.search);
      expect(generateURLPermutations(alias).map(url => url.href)).toEqual(
        aliases.map(url => url.href),
      );
    }
  });

  it.each([
    ["http://example.com/docs", "https://example.com:80/docs"],
    ["https://example.com:80/docs", "http://example.com/docs"],
    ["http://example.com:8080/docs", "https://example.com:8080/docs"],
    ["https://example.com:8080/docs", "http://example.com:8080/docs"],
  ])("locks both distinct services %s and %s", async (first, second) => {
    expect(await lockURL("crawl", crawl, first)).toBe(true);
    expect(await lockURL("crawl", crawl, second)).toBe(true);
    expect(fake.sets.get("crawl:crawl:visited_unique")).toEqual(
      new Set([first, second]),
    );
  });

  it("still deduplicates the default HTTP/HTTPS service aliases", async () => {
    expect(await lockURL("crawl", crawl, "http://example.com:80/docs")).toBe(
      true,
    );
    expect(
      await lockURL(
        "crawl",
        crawl,
        "https://www.example.com:443/docs/index.html",
      ),
    ).toBe(false);
  });

  it("still deduplicates paths and www at the same custom origin", async () => {
    expect(await lockURL("crawl", crawl, "https://example.com:8080/docs")).toBe(
      true,
    );
    expect(
      await lockURL(
        "crawl",
        crawl,
        "https://www.example.com:8080/docs/index.php",
      ),
    ).toBe(false);
  });

  it("keeps different custom port numbers separate", async () => {
    expect(await lockURL("crawl", crawl, "https://example.com:8080/docs")).toBe(
      true,
    );
    expect(await lockURL("crawl", crawl, "https://example.com:8443/docs")).toBe(
      true,
    );
  });

  it("leaves the no-deduplication option unchanged", async () => {
    const exact = {
      ...crawl,
      crawlerOptions: { deduplicateSimilarURLs: false },
    };
    expect(await lockURL("crawl", exact, "http://example.com/docs")).toBe(true);
    expect(await lockURL("crawl", exact, "https://example.com/docs")).toBe(
      true,
    );
    expect(await lockURL("crawl", exact, "http://example.com/docs")).toBe(
      false,
    );
  });
});
