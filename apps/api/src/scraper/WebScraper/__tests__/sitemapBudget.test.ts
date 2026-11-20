import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  sets: new Map<string, Set<string>>(),
  failValue: undefined as string | undefined,
  beforeReply: undefined as (() => Promise<void>) | undefined,
  beforeMembershipReply: undefined as (() => Promise<void>) | undefined,
  beforeExpire: undefined as (() => Promise<void>) | undefined,
  failMemberValue: undefined as string | undefined,
  pipelineSizes: [] as number[],
  warnings: [] as string[],
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
      srem: async (key: string, ...values: string[]) =>
        values.reduce(
          (removed, value) =>
            removed + (fake.sets.get(key)?.delete(value) ? 1 : 0),
          0,
        ),
      expire: async () => {
        await fake.beforeExpire?.();
        return 1;
      },
      pipeline: () => {
        const commands: Array<() => [Error | null, number | null]> = [];
        let membership = false;
        const pipeline = {
          sismember(key: string, value: string) {
            membership = true;
            commands.push(() =>
              value === fake.failMemberValue
                ? [new Error("SISMEMBER failed"), null]
                : [null, fake.sets.get(key)?.has(value) ? 1 : 0],
            );
            return pipeline;
          },
          sadd(key: string, value: string) {
            commands.push(() =>
              value === fake.failValue
                ? [new Error("SADD failed"), null]
                : [null, sadd(key, value)],
            );
            return pipeline;
          },
          async exec() {
            fake.pipelineSizes.push(commands.length);
            const results = commands.map(command => command());
            if (membership) await fake.beforeMembershipReply?.();
            else await fake.beforeReply?.();
            return results;
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
  filterLinks: vi.fn(
    async ({ links, limit }: { links: string[]; limit?: number }) => ({
      links: links.filter(link => !link.endsWith("/excluded")).slice(0, limit),
      denialReasons: {},
      robotsBlocked: [],
    }),
  ),
}));

import { WebCrawler } from "../crawler";
import { filterLinks as nativeFilterLinks } from "@mendable/firecrawl-rs";

beforeEach(() => {
  fake.sets.clear();
  fake.failValue = undefined;
  fake.beforeReply = undefined;
  fake.beforeMembershipReply = undefined;
  fake.beforeExpire = undefined;
  fake.failMemberValue = undefined;
  fake.pipelineSizes.length = 0;
  fake.warnings.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const A = "https://example.com/a";
const B = "https://example.com/b";
const C = "https://example.com/c";
const D = "https://example.com/d";

async function discover(
  batches: string[][],
  limit: number,
  concurrent = false,
  onlySitemap = false,
  onBatch?: (batch: string[]) => Promise<void>,
  timeout = 120000,
) {
  const crawler = new WebCrawler({ jobId: "budget", initialUrl: A, limit });
  vi.spyOn((crawler as any).logger, "warn").mockImplementation(
    (message: string) => {
      fake.warnings.push(message);
    },
  );
  vi.spyOn(crawler as any, "tryFetchSitemapLinks").mockImplementation(
    async (_source: string, handler: (batch: string[]) => Promise<void>) => {
      if (concurrent) await Promise.all(batches.map(batch => handler(batch)));
      else for (const batch of batches) await handler(batch);
      return batches.reduce((sum, batch) => sum + batch.length, 0);
    },
  );
  const delivered: string[] = [];
  await crawler.tryGetSitemap(
    async batch => {
      delivered.push(...batch);
      await onBatch?.(batch);
    },
    true,
    onlySitemap,
    timeout,
  );
  return delivered;
}

describe("sitemap unique delivery budget", () => {
  it("does not spend later capacity on URLs delivered by an earlier sitemap", async () => {
    expect(
      await discover(
        [
          [A, B],
          [A, C, D],
        ],
        3,
      ),
    ).toEqual([A, B, C]);
  });

  it("looks past protocol/www/slash aliases to fill the requested capacity", async () => {
    expect(
      await discover(
        [[A, "http://example.com/a", "https://www.example.com/a/", B, C]],
        3,
      ),
    ).toEqual([A, B, C]);
  });

  it("looks past already-recorded Redis keys rather than truncating before deduplication", async () => {
    fake.sets.set(
      "sitemap:budget:links",
      new Set(["example.com/a", "example.com/b"]),
    );
    expect(await discover([[A, B, C, D]], 2)).toEqual([C, D]);
  });

  it("shares remaining capacity across simultaneously completed sitemap batches", async () => {
    const delivered = await discover([[A], [B, C], [D]], 3, true);
    expect(delivered).toEqual([A, B, C]);
  });

  it("does not spend delivery capacity on a failed Redis command", async () => {
    fake.failValue = "example.com/b";
    expect(await discover([[A, B, C, D]], 3)).toEqual([A, C, D]);
    expect(fake.warnings).toContain(
      "Could not reserve sitemap URLs after retrying Redis commands",
    );
    expect(fake.pipelineSizes).toEqual([3, 1, 1, 1]);
  });

  it("retries a transient per-command reservation failure without losing discovery order", async () => {
    fake.failValue = "example.com/b";
    fake.beforeReply = async () => {
      fake.failValue = undefined;
    };
    expect(await discover([[A, B, C]], 3)).toEqual([A, B, C]);
    expect(fake.pipelineSizes).toEqual([3, 1]);
    expect(fake.warnings).toEqual([]);
  });

  it("keeps valid discovery order and stops at the limit", async () => {
    expect(await discover([[A, B, C, D]], 2)).toEqual([A, B]);
  });

  it("retains the existing policy filter before selecting results", async () => {
    expect(
      await discover([["https://example.com/excluded", A, B, C]], 3),
    ).toEqual([A, B, C]);
  });

  it("does not deliver more batches once capacity is exhausted", async () => {
    expect(await discover([[A], [B, C], [D]], 1)).toEqual([A]);
  });

  it("retains the unbounded sitemap-only map path", async () => {
    expect(
      await discover(
        [
          [A, B],
          [A, C],
        ],
        1,
        false,
        true,
      ),
    ).toEqual([A, B, A, C, A]);
  });
});

function gate() {
  let open!: () => void;
  const wait = new Promise<void>(resolve => {
    open = resolve;
  });
  return { wait, open };
}

it("does not start queued delivery after the sitemap timeout has returned", async () => {
  vi.useFakeTimers();
  const started = gate();
  const release = gate();
  const response = discover(
    [[A], [B]],
    2,
    true,
    false,
    async batch => {
      if (batch[0] === A) {
        started.open();
        await release.wait;
      }
    },
    10,
  );
  await started.wait;
  await vi.advanceTimersByTimeAsync(10);
  expect(await response).toEqual([A]);
  release.open();
  await vi.runAllTimersAsync();
  expect(fake.sets.get("sitemap:budget:links")?.has("example.com/b")).not.toBe(
    true,
  );
});

it("does not reserve URLs after filtering finishes past the timeout", async () => {
  vi.useFakeTimers();
  const started = gate();
  const release = gate();
  vi.mocked(nativeFilterLinks).mockImplementationOnce(async ({ links }) => {
    started.open();
    await release.wait;
    return { links, denialReasons: {}, robotsBlocked: [] } as any;
  });
  const response = discover([[A, B]], 2, false, false, undefined, 10);
  await started.wait;
  await vi.advanceTimersByTimeAsync(10);
  expect(await response).toEqual([]);
  release.open();
  await vi.runAllTimersAsync();
  expect(fake.sets.size).toBe(0);
});

it("does not deliver a Redis reservation whose reply arrives after the timeout", async () => {
  vi.useFakeTimers();
  const started = gate();
  const release = gate();
  fake.beforeReply = async () => {
    started.open();
    await release.wait;
  };
  const response = discover([[A, B]], 2, false, false, undefined, 10);
  await started.wait;
  await vi.advanceTimersByTimeAsync(10);
  const delivered = await response;
  expect(delivered).toEqual([]);
  release.open();
  await vi.runAllTimersAsync();
  // Release only this batch's new reservations; a retry can still deliver them.
  expect(fake.sets.get("sitemap:budget:links")?.has("example.com/a")).toBe(
    false,
  );
  expect(delivered).toEqual([]);
  fake.beforeReply = undefined;
  expect(await discover([[A, B]], 2)).toEqual([A, B]);
});

it("releases new reservations when expiration finishes after timeout while preserving existing keys", async () => {
  vi.useFakeTimers();
  fake.sets.set("sitemap:budget:links", new Set(["example.com/a"]));
  const started = gate();
  const release = gate();
  fake.beforeExpire = async () => {
    fake.beforeExpire = undefined;
    started.open();
    await release.wait;
  };
  const response = discover([[A, B]], 2, false, false, undefined, 10);
  await started.wait;
  await vi.advanceTimersByTimeAsync(10);
  const delivered = await response;
  expect(delivered).toEqual([]);
  release.open();
  await vi.runAllTimersAsync();
  expect(fake.sets.get("sitemap:budget:links")).toEqual(
    new Set(["example.com/a"]),
  );
  expect(delivered).toEqual([]);
  expect(await discover([[A, B]], 2)).toEqual([B]);
});

it("batches membership checks when a small remaining budget follows many stored URLs", async () => {
  const existing = [
    A,
    ...Array.from({ length: 2048 }, (_, i) => `https://example.com/old-${i}`),
  ];
  fake.sets.set(
    "sitemap:budget:links",
    new Set(existing.map(url => url.replace(/^https:\/\//, ""))),
  );
  expect(await discover([[...existing, B]], 1)).toEqual([B]);
  // There are 2049 stored keys: do not make one network round trip per key.
  expect(fake.pipelineSizes.length).toBeLessThan(12);
  expect(Math.max(...fake.pipelineSizes)).toBeLessThanOrEqual(512);
});

it("falls back to SADD when a membership lookup fails", async () => {
  fake.sets.set("sitemap:budget:links", new Set(["example.com/a"]));
  fake.failMemberValue = "example.com/b";
  expect(await discover([[A, B, C]], 1)).toEqual([B]);
  expect(fake.sets.get("sitemap:budget:links")?.has("example.com/c")).toBe(
    false,
  );
});

it("does not reserve URLs after a membership reply arrives past the timeout", async () => {
  vi.useFakeTimers();
  fake.sets.set("sitemap:budget:links", new Set(["example.com/a"]));
  const started = gate();
  const release = gate();
  fake.beforeMembershipReply = async () => {
    started.open();
    await release.wait;
  };
  const response = discover([[A, B]], 1, false, false, undefined, 10);
  await started.wait;
  await vi.advanceTimersByTimeAsync(10);
  expect(await response).toEqual([]);
  release.open();
  await vi.runAllTimersAsync();
  expect(fake.sets.get("sitemap:budget:links")?.has("example.com/b")).toBe(
    false,
  );
});
