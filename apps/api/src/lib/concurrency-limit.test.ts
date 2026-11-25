import type { Mock } from "vitest";
import {
  crawlConcurrencyLimit,
  getNextConcurrentJob,
} from "./concurrency-limit";
import { getCrawl } from "./crawl-redis";

const { store, fakeRedis } = vi.hoisted(() => {
  const store = {
    queue: new Map<string, number>(),
    jobs: new Map<string, string>(),
    crawlActive: new Map<string, number>(),
  };

  const fakeRedis = {
    zpopmin: vi.fn(async () => {
      const entries = [...store.queue.entries()].sort((a, b) => a[1] - b[1]);
      if (entries.length === 0) return [];
      const [member, score] = entries[0];
      store.queue.delete(member);
      return [member, String(score)];
    }),
    zadd: vi.fn(async (_key: string, ...args: (string | number)[]) => {
      for (let i = 0; i < args.length; i += 2) {
        store.queue.set(String(args[i + 1]), Number(args[i]));
      }
    }),
    get: vi.fn(async (key: string) => store.jobs.get(key) ?? null),
    del: vi.fn(async (key: string) => {
      store.jobs.delete(key);
    }),
    zrangebyscore: vi.fn(async () => [...store.crawlActive.keys()]),
  };

  return { store, fakeRedis };
});

vi.mock("../services/queue-service", () => ({
  getRedisConnection: () => fakeRedis,
}));

vi.mock("./crawl-redis", () => ({
  getCrawl: vi.fn(),
}));

vi.mock("../services/worker/nuq", () => ({
  scrapeQueue: {},
}));

vi.mock("../controllers/auth", () => ({
  getACUCTeam: vi.fn(async () => null),
}));

function enqueue(id: string, crawlId: string) {
  store.queue.set(id, Date.now() + 60_000);
  store.jobs.set(
    "cq-job:" + id,
    JSON.stringify({
      id,
      data: { crawl_id: crawlId, team_id: "team-1" },
      priority: 0,
      listenable: false,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  store.queue.clear();
  store.jobs.clear();
  store.crawlActive.clear();
});

describe("crawlConcurrencyLimit", () => {
  test("allows one job when the crawl document is missing", () => {
    expect(crawlConcurrencyLimit(null)).toBe(1);
  });

  test("allows one job when the crawl has a delay", () => {
    expect(
      crawlConcurrencyLimit({
        crawlerOptions: { delay: 2 },
        maxConcurrency: 5,
      } as any),
    ).toBe(1);
  });

  test("uses maxConcurrency, or no crawl limit when unset", () => {
    expect(
      crawlConcurrencyLimit({ crawlerOptions: {}, maxConcurrency: 3 } as any),
    ).toBe(3);
    expect(crawlConcurrencyLimit({ crawlerOptions: null } as any)).toBeNull();
  });
});

describe("getNextConcurrentJob with a missing crawl document", () => {
  test("holds the job while one job of the crawl is active", async () => {
    (getCrawl as Mock).mockResolvedValue(null);
    store.crawlActive.set("running-job", Date.now() + 60_000);
    enqueue("job-a", "crawl-1");
    enqueue("job-b", "crawl-1");

    await expect(getNextConcurrentJob("team-1")).resolves.toBeNull();
    expect([...store.queue.keys()].sort()).toEqual(["job-a", "job-b"]);
    expect(getCrawl).toHaveBeenCalledTimes(1);
  });

  test("promotes one job when none of the crawl is active", async () => {
    (getCrawl as Mock).mockResolvedValue(null);
    enqueue("job-a", "crawl-1");

    const next = await getNextConcurrentJob("team-1");
    expect(next?.job.id).toBe("job-a");
    expect(store.queue.size).toBe(0);
  });
});
