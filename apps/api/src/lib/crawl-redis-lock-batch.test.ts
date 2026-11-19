import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory stand-in for the lock script: same inputs, same answer, same
// writes. The script itself runs against a real store in the e2e suites.
const store = vi.hoisted(() => ({
  sets: new Map<string, Set<string>>(),
  strings: new Map<string, string>(),
  calls: [] as { keys: string[]; args: string[] }[],
  failAfterApplying: 0,
  failBeforeApplying: 0,
  failFromCall: 0,
  failFilter: false,
  filterCalls: 0,
}));

function set(key: string): Set<string> {
  let value = store.sets.get(key);
  if (!value) {
    value = new Set();
    store.sets.set(key, value);
  }
  return value;
}

vi.mock("../services/redis", () => ({
  redisEvictConnection: {
    get: vi.fn(async (key: string) => {
      if (store.failFilter) throw new Error("Command timed out");
      return store.strings.get(key) ?? null;
    }),
    srem: vi.fn(async (key: string, ...members: string[]) => {
      if (store.failFilter) throw new Error("Command timed out");
      return members.filter(member => set(key).delete(member)).length;
    }),
    smismember: vi.fn(async (key: string, ...members: string[]) => {
      store.filterCalls++;
      if (store.failFilter) throw new Error("ERR unknown command");
      return members.map(member => (set(key).has(member) ? 1 : 0));
    }),
    eval: vi.fn(
      async (_script: string, numKeys: number, ...rest: unknown[]) => {
        const keys = rest.slice(0, numKeys).map(String);
        const args = rest.slice(numKeys).map(String);
        store.calls.push({ keys, args });
        if (store.failBeforeApplying > 0) {
          store.failBeforeApplying--;
          throw new Error("Command timed out");
        }
        if (
          store.failFromCall > 0 &&
          store.calls.length >= store.failFromCall
        ) {
          throw new Error("Command timed out");
        }

        const [visited, visitedUnique, replayKey] = keys;
        let result = store.strings.get(replayKey);
        if (result === undefined) {
          const limit = Number(args[0]);
          let count = limit >= 0 ? set(visitedUnique).size : 0;
          const locked: number[] = [];
          let position = 0;
          for (let i = 3; i < args.length; i += 2) {
            position++;
            if (limit >= 0 && count >= limit) break;
            if (!set(visited).has(args[i])) {
              set(visited).add(args[i]);
              if (!set(visitedUnique).has(args[i + 1])) {
                set(visitedUnique).add(args[i + 1]);
                count++;
              }
              locked.push(position);
            }
          }
          result = locked.join(",");
          store.strings.set(replayKey, result);
        }

        if (store.failAfterApplying > 0) {
          store.failAfterApplying--;
          throw new Error("Command timed out");
        }
        return result;
      },
    ),
  },
}));

vi.mock("../scraper/WebScraper/crawler", () => ({ WebCrawler: class {} }));

import {
  lockURLsBatch,
  lockURLsIndividually,
  unlockURLs,
  type StoredCrawl,
} from "./crawl-redis";

const quiet = { error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as any;

function crawl(crawlerOptions: Record<string, unknown> = {}): StoredCrawl {
  return {
    crawlerOptions,
    scrapeOptions: {},
    internalOptions: {},
    team_id: "team",
    createdAt: 0,
  } as StoredCrawl;
}

const visited = "crawl:c1:visited";
const visitedUnique = "crawl:c1:visited_unique";

beforeEach(() => {
  store.sets.clear();
  store.strings.clear();
  store.calls.length = 0;
  store.failAfterApplying = 0;
  store.failBeforeApplying = 0;
  store.failFromCall = 0;
  store.failFilter = false;
  store.filterCalls = 0;
});

describe("lockURLsBatch", () => {
  it("locks new URLs and skips visited ones, aligned with the input", async () => {
    set(visited).add("https://example.com/seen");

    const locked = await lockURLsBatch(
      "c1",
      crawl(),
      [
        "https://example.com/a",
        "https://example.com/seen",
        "https://example.com/b",
      ],
      quiet,
    );

    expect(locked).toEqual([true, false, true]);
    expect([...set(visitedUnique)]).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
    expect(store.calls).toHaveLength(1);
  });

  it("sends nothing for an empty list", async () => {
    expect(await lockURLsBatch("c1", crawl(), [], quiet)).toEqual([]);
    expect(store.calls).toHaveLength(0);
    expect(store.filterCalls).toBe(0);
  });

  it("skips the script when every URL was already visited", async () => {
    set(visited).add("https://example.com/a");
    set(visited).add("https://example.com/b");

    const locked = await lockURLsBatch(
      "c1",
      crawl(),
      ["https://example.com/a", "https://example.com/b"],
      quiet,
    );

    expect(locked).toEqual([false, false]);
    expect(store.filterCalls).toBe(1);
    expect(store.calls).toHaveLength(0);
  });

  it("sends only unvisited URLs to the script", async () => {
    set(visited).add("https://example.com/seen-1");
    set(visited).add("https://example.com/seen-2");

    const locked = await lockURLsBatch(
      "c1",
      crawl(),
      [
        "https://example.com/seen-1",
        "https://example.com/new-1",
        "https://example.com/seen-2",
        "https://example.com/new-2",
      ],
      quiet,
    );

    expect(locked).toEqual([false, true, false, true]);
    // limit, two TTLs, then one (target, URL) pair per unvisited URL
    expect(store.calls[0].args).toHaveLength(3 + 2 * 2);
  });

  it("still locks correctly when the pre-filter read fails", async () => {
    store.failFilter = true;
    set(visited).add("https://example.com/seen");

    const locked = await lockURLsBatch(
      "c1",
      crawl(),
      ["https://example.com/seen", "https://example.com/new"],
      quiet,
    );

    expect(locked).toEqual([false, true]);
    expect(store.calls[0].args).toHaveLength(3 + 2 * 2);
  });

  it("locks a URL repeated in one batch once", async () => {
    const locked = await lockURLsBatch(
      "c1",
      crawl(),
      [
        "https://example.com/a",
        "https://example.com/a#section",
        "https://example.com/a",
      ],
      quiet,
    );

    expect(locked).toEqual([true, false, false]);
  });

  it("stops at the crawl limit, counting URLs locked earlier", async () => {
    set(visitedUnique).add("https://example.com/first");
    set(visited).add("https://example.com/first");

    const locked = await lockURLsBatch(
      "c1",
      crawl({ limit: 3 }),
      [
        "https://example.com/a",
        "https://example.com/first",
        "https://example.com/b",
        "https://example.com/c",
        "https://example.com/d",
      ],
      quiet,
    );

    expect(locked).toEqual([true, false, true, false, false]);
    expect(set(visitedUnique).size).toBe(3);
    // Nothing past the limit is marked visited, so a later crawl of the same
    // id could still reach it.
    expect(set(visited).has("https://example.com/c")).toBe(false);
  });

  it("locks nothing when the limit is already reached", async () => {
    set(visitedUnique).add("https://example.com/first");

    const locked = await lockURLsBatch(
      "c1",
      crawl({ limit: 1 }),
      ["https://example.com/a"],
      quiet,
    );

    expect(locked).toEqual([false]);
  });

  it("locks nothing when the limit is negative", async () => {
    const locked = await lockURLsBatch(
      "c1",
      crawl({ limit: -5 }),
      ["https://example.com/a"],
      quiet,
    );

    expect(locked).toEqual([false]);
    expect(set(visited).size).toBe(0);
  });

  it("treats similar URLs as one when the crawl deduplicates them", async () => {
    const locked = await lockURLsBatch(
      "c1",
      crawl({ deduplicateSimilarURLs: true }),
      [
        "https://example.com/docs",
        "https://www.example.com/docs/",
        "http://example.com/docs/index.html",
        "https://example.com/other",
      ],
      quiet,
    );

    expect(locked).toEqual([true, false, false, true]);
    expect(set(visited).size).toBe(2);
    expect(set(visitedUnique).has("https://example.com/docs")).toBe(true);
  });

  it("drops query strings when the crawl ignores them", async () => {
    const locked = await lockURLsBatch(
      "c1",
      crawl({ ignoreQueryParameters: true }),
      ["https://example.com/a?x=1", "https://example.com/a?x=2"],
      quiet,
    );

    expect(locked).toEqual([true, false]);
  });

  it("keeps its locks when the reply is lost and the call is retried", async () => {
    store.failAfterApplying = 1;

    const locked = await lockURLsBatch(
      "c1",
      crawl(),
      ["https://example.com/a", "https://example.com/b"],
      quiet,
    );

    expect(locked).toEqual([true, true]);
    expect(store.calls).toHaveLength(2);
    // The retry asks under the same replay key.
    expect(store.calls[1].keys[2]).toBe(store.calls[0].keys[2]);
  });

  it("retries a call that never reached the store", async () => {
    store.failBeforeApplying = 2;

    const locked = await lockURLsBatch(
      "c1",
      crawl(),
      ["https://example.com/a"],
      quiet,
    );

    expect(locked).toEqual([true]);
    expect(store.calls).toHaveLength(3);
  });

  it("reads the stored answer when every reply was lost", async () => {
    store.failAfterApplying = 3;

    const locked = await lockURLsBatch(
      "c1",
      crawl(),
      ["https://example.com/a", "https://example.com/b"],
      quiet,
    );

    expect(locked).toEqual([true, true]);
    expect(store.calls).toHaveLength(3);
  });

  it("throws after three failed attempts", async () => {
    store.failBeforeApplying = 3;

    await expect(
      lockURLsBatch("c1", crawl(), ["https://example.com/a"], quiet),
    ).rejects.toThrow("URL lock script failed after retries");
  });

  it("releases the URLs it locked when a later call fails", async () => {
    const urls = Array.from(
      { length: 1500 },
      (_, i) => "https://example.com/p/" + i,
    );
    store.failFromCall = 2;

    await expect(lockURLsBatch("c1", crawl(), urls, quiet)).rejects.toThrow(
      "URL lock script failed after retries",
    );

    expect(set(visited).size).toBe(0);
    expect(set(visitedUnique).size).toBe(0);
  });

  it("splits a long list into several calls and keeps positions", async () => {
    const urls = Array.from(
      { length: 2500 },
      (_, i) => "https://example.com/p/" + i,
    );
    set(visited).add("https://example.com/p/1700");

    const locked = await lockURLsBatch("c1", crawl(), urls, quiet);

    expect(store.calls).toHaveLength(3);
    expect(locked.filter(Boolean)).toHaveLength(2499);
    expect(locked[1700]).toBe(false);
    expect(locked[2499]).toBe(true);
    // Each call gets its own replay key.
    expect(new Set(store.calls.map(call => call.keys[2])).size).toBe(3);
  });

  it("carries the limit across calls", async () => {
    const urls = Array.from(
      { length: 1500 },
      (_, i) => "https://example.com/p/" + i,
    );

    const locked = await lockURLsBatch(
      "c1",
      crawl({ limit: 1200 }),
      urls,
      quiet,
    );

    expect(locked.filter(Boolean)).toHaveLength(1200);
    expect(locked[1199]).toBe(true);
    expect(locked[1200]).toBe(false);
  });
});

describe("lockURLsIndividually", () => {
  it("returns the jobs whose URLs were locked", async () => {
    set(visited).add("https://example.com/seen");

    const jobs = [
      { id: "1", url: "https://example.com/a" },
      { id: "2", url: "https://example.com/seen" },
      { id: "3", url: "https://example.com/b" },
    ];

    expect(await lockURLsIndividually("c1", crawl(), jobs)).toEqual([
      jobs[0],
      jobs[2],
    ]);
  });
});

describe("unlockURLs", () => {
  it("lets a released URL be locked again", async () => {
    const urls = ["https://example.com/a", "https://www.example.com/b/"];
    const sc = crawl({ deduplicateSimilarURLs: true, limit: 2 });
    expect(await lockURLsBatch("c1", sc, urls, quiet)).toEqual([true, true]);

    await unlockURLs("c1", sc, [urls[1]], quiet);

    expect(set(visited).size).toBe(1);
    expect([...set(visitedUnique)]).toEqual(["https://example.com/a"]);
    expect(await lockURLsBatch("c1", sc, urls, quiet)).toEqual([false, true]);
  });

  it("does not throw when the store fails", async () => {
    store.failFilter = true;

    await expect(
      unlockURLs("c1", crawl(), ["https://example.com/a"], quiet),
    ).resolves.toBeUndefined();
  });
});
