import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => new Map<string, string>());
const expiries = vi.hoisted(() => new Map<string, unknown[]>());
const failNextWrite = vi.hoisted(() => ({ value: false }));
const pipelineUnavailable = vi.hoisted(() => ({ value: false }));
const mget = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());
vi.mock("./logger", () => ({ logger: { warn } }));
vi.mock("../services/rate-limiter", () => ({
  redisRateLimitClient: {
    pipeline: () => {
      if (pipelineUnavailable.value) throw new Error("Connection is closed.");
      const writes: [string, string][] = [];
      const pipeline = {
        set: (key: string, value: string, ...expiry: unknown[]) => {
          writes.push([key, value]);
          expiries.set(key, expiry);
          return pipeline;
        },
        exec: async () => {
          if (failNextWrite.value) {
            failNextWrite.value = false;
            return writes.map(() => [new Error("OOM"), null]);
          }
          for (const [key, value] of writes) store.set(key, value);
          return writes.map(() => [null, "OK"]);
        },
      };
      return pipeline;
    },
    mget: (keys: string[]) => mget(keys),
  },
}));
import { config } from "../config";
import {
  discoveryForCalls,
  libraryCommandTools,
  recordDiscoveredTools,
} from "./alexandria-discovery";

beforeEach(() => {
  store.clear();
  expiries.clear();
  warn.mockClear();
  mget.mockReset();
  mget.mockImplementation(async (keys: string[]) =>
    keys.map(key => store.get(key) ?? null),
  );
  pipelineUnavailable.value = false;
  config.ALEXANDRIA_SEARCH_CONTEXT_ENABLED = true;
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("attributes a call to the latest search and find-tools jobs that showed it", async () => {
  const sponsors = { provider: "particle", capability: "advertising/sponsors" };
  recordDiscoveredTools("team", "search", "search-1", [sponsors]);
  recordDiscoveredTools("team", "find_tools", "scrape-1", [sponsors]);
  recordDiscoveredTools("team", "find_tools", "scrape-2", [sponsors]);
  await vi.waitFor(() => expect(store.size).toBe(2));
  for (const key of store.keys()) {
    expect(expiries.get(key)).toEqual(["EX", 3600]);
  }

  const [found, missing] = await discoveryForCalls("team", [
    sponsors,
    { provider: "fred", capability: "series/search" },
  ]);
  expect(found.discovery).toEqual({
    search: { id: "search-1", secondsBefore: expect.any(Number) },
    find_tools: { id: "scrape-2", secondsBefore: expect.any(Number) },
  });
  expect(missing).toEqual({ discovery: {} });
});

it("keeps teams and provider/capability splits apart", async () => {
  recordDiscoveredTools("other-team", "search", "search-1", [
    { provider: "fred", capability: "series/search" },
  ]);
  recordDiscoveredTools("team", "search", "search-2", [
    { provider: "a/b", capability: "c" },
  ]);
  await vi.waitFor(() => expect(store.size).toBe(2));
  expect(
    await discoveryForCalls("team", [
      { provider: "fred", capability: "series/search" },
      { provider: "a", capability: "b/c" },
    ]),
  ).toEqual([{ discovery: {} }, { discovery: {} }]);
});

it("treats a malformed entry as a miss without dropping the others", async () => {
  const tool = { provider: "fred", capability: "series/search" };
  recordDiscoveredTools("team", "search", "search-1", [tool]);
  await vi.waitFor(() => expect(store.size).toBe(1));
  const [searchKey] = store.keys();
  store.set(searchKey!.replace('"search"', '"find_tools"'), "not json");
  store.set(searchKey!.replace('"search"', '"auto_search"'), "null");
  expect((await discoveryForCalls("team", [tool]))[0].discovery).toEqual({
    search: { id: "search-1", secondsBefore: expect.any(Number) },
  });
});

it("logs a write that Redis refused", async () => {
  failNextWrite.value = true;
  recordDiscoveredTools("team", "search", "search-1", [
    { provider: "fred", capability: "series/search" },
  ]);
  await vi.waitFor(() =>
    expect(warn).toHaveBeenCalledWith("Failed to record Alexandria discovery", {
      error: expect.any(Error),
      teamId: "team",
    }),
  );
  expect(store.size).toBe(0);
});

describe("the search that led to a call", () => {
  const forecast = { provider: "open-meteo", capability: "forecast/daily" };
  const geocode = { provider: "open-meteo", capability: "geocoding/search" };
  const START = Date.UTC(2026, 0, 5, 12);
  // Records at a number of seconds after START, so recency is exact.
  const recordAt = (
    seconds: number,
    ...args: Parameters<typeof recordDiscoveredTools>
  ) => {
    vi.spyOn(Date, "now").mockReturnValue(START + seconds * 1000);
    recordDiscoveredTools(...args);
  };
  const searchAt = async (
    seconds: number,
    lineage?: Parameters<typeof discoveryForCalls>[2],
    calls = [forecast],
  ) => {
    vi.spyOn(Date, "now").mockReturnValue(START + seconds * 1000);
    return (await discoveryForCalls("team", calls, lineage)).map(
      found => found.search,
    );
  };

  it("names the search with its source, rank and distance for the same team", async () => {
    recordAt(0, "team", "auto_search", "search-1", [geocode, forecast]);
    expect(await searchAt(40)).toEqual([
      {
        id: "search-1",
        source: "auto_search",
        rank: 2,
        match: "team",
        secondsBefore: 40,
      },
    ]);
  });

  it("matches by conversation when the call and the search share one", async () => {
    recordAt(0, "team", "search", "search-1", [forecast], {
      sessionId: "sess_1",
      threadId: "thread_1",
    });
    expect(
      await searchAt(5, { sessionId: "sess_2", threadId: "thread_1" }),
    ).toEqual([
      {
        id: "search-1",
        source: "search",
        rank: 1,
        match: "conversation",
        secondsBefore: 5,
      },
    ]);
  });

  it("matches by session when only the session is shared", async () => {
    recordAt(0, "team", "search", "search-1", [forecast], {
      sessionId: "sess_1",
      threadId: "thread_1",
    });
    expect(
      await searchAt(5, { sessionId: "sess_1", threadId: "thread_2" }),
    ).toMatchObject([{ id: "search-1", match: "session" }]);
    expect(await searchAt(5, { sessionId: "sess_1" })).toMatchObject([
      { id: "search-1", match: "session" },
    ]);
  });

  it("falls back to the team when neither is shared", async () => {
    recordAt(0, "team", "search", "search-1", [forecast], {
      sessionId: "sess_1",
      threadId: "thread_1",
    });
    expect(
      await searchAt(5, { sessionId: "sess_2", threadId: "thread_2" }),
    ).toMatchObject([{ id: "search-1", match: "team" }]);
    expect(await searchAt(5)).toMatchObject([
      { id: "search-1", match: "team" },
    ]);
  });

  it("prefers the conversation's search over a more recent one from the team or the session", async () => {
    recordAt(0, "team", "search", "search-own", [forecast], {
      sessionId: "sess_1",
      threadId: "thread_1",
    });
    recordAt(10, "team", "find_tools", "scrape-session", [forecast], {
      sessionId: "sess_1",
      threadId: "thread_2",
    });
    recordAt(20, "team", "auto_search", "search-other", [forecast]);
    const lineage = { sessionId: "sess_1", threadId: "thread_1" };
    expect(await searchAt(30, lineage)).toMatchObject([
      { id: "search-own", match: "conversation", secondsBefore: 30 },
    ]);
    expect(await searchAt(30, { sessionId: "sess_1" })).toMatchObject([
      { id: "scrape-session", match: "session", secondsBefore: 20 },
    ]);
    expect(await searchAt(30)).toMatchObject([
      { id: "search-other", match: "team", secondsBefore: 10 },
    ]);
  });

  it("picks the most recent search of the best class, across sources", async () => {
    const lineage = { threadId: "thread_1" };
    recordAt(0, "team", "search", "search-1", [forecast], lineage);
    recordAt(10, "team", "find_tools", "scrape-1", [geocode, forecast], {
      ...lineage,
      requestId: "exchange-request-1",
    });
    recordAt(5, "team", "auto_search", "search-2", [forecast], lineage);
    expect(await searchAt(30, lineage)).toEqual([
      {
        id: "scrape-1",
        source: "find_tools",
        rank: 2,
        match: "conversation",
        secondsBefore: 20,
        requestId: "exchange-request-1",
      },
    ]);
  });

  it("keeps a tool's first rank when a list names it twice, and takes a given rank", async () => {
    recordAt(0, "team", "find_tools", "scrape-1", [
      { ...forecast, rank: 11 },
      { ...geocode, rank: 12 },
      { ...forecast, rank: 13 },
    ]);
    expect(
      (await searchAt(1, undefined, [forecast, geocode])).map(
        search => search?.rank,
      ),
    ).toEqual([11, 12]);
  });

  it("attributes a call to the library command that listed its contract, without adding to discovery", async () => {
    const listed = libraryCommandTools(
      "grep -rl forecast /library/weather",
      "/library/weather/open-meteo/geocoding/search.md\n/library/weather/open-meteo/forecast/daily.md\n",
    );
    recordAt(0, "team", "library", "scrape-9", listed, {
      threadId: "thread_1",
      requestId: "exchange-request-9",
    });
    vi.spyOn(Date, "now").mockReturnValue(START + 15_000);
    expect(
      await discoveryForCalls("team", [forecast], { threadId: "thread_1" }),
    ).toEqual([
      {
        discovery: {},
        search: {
          id: "scrape-9",
          source: "library",
          rank: 2,
          match: "conversation",
          secondsBefore: 15,
          requestId: "exchange-request-9",
        },
      },
    ]);
  });

  it("scopes the conversation and session keys to the team and keeps them for the same hour", async () => {
    recordAt(0, "other-team", "search", "search-1", [forecast], {
      sessionId: "sess_1",
      threadId: "thread_1",
    });
    expect(store.size).toBe(3);
    for (const key of store.keys())
      expect(expiries.get(key)).toEqual(["EX", 3600]);
    expect(
      await searchAt(5, { sessionId: "sess_1", threadId: "thread_1" }),
    ).toEqual([undefined]);
  });

  it("reads every class and source for all calls in one round trip", async () => {
    await searchAt(0, { sessionId: "sess_1", threadId: "thread_1" }, [
      forecast,
      geocode,
    ]);
    expect(mget).toHaveBeenCalledTimes(1);
    // Two calls, four sources, three classes.
    expect(mget.mock.calls[0][0]).toHaveLength(24);
  });

  it("still names a search recorded without a rank", async () => {
    store.set(
      `alexandria:discovered:${JSON.stringify(["search", "team", forecast.provider, forecast.capability])}`,
      JSON.stringify({ id: "search-0", at: START }),
    );
    expect(await searchAt(7)).toEqual([
      { id: "search-0", source: "search", match: "team", secondsBefore: 7 },
    ]);
  });

  it("does not throw when Redis cannot take the write", async () => {
    pipelineUnavailable.value = true;
    expect(() =>
      recordDiscoveredTools("team", "search", "search-1", [forecast]),
    ).not.toThrow();
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        "Failed to record Alexandria discovery",
        { error: expect.any(Error), teamId: "team" },
      ),
    );
  });

  describe("with the switch off", () => {
    beforeEach(() => {
      config.ALEXANDRIA_SEARCH_CONTEXT_ENABLED = false;
    });

    it("records and reads the team keys exactly as before", async () => {
      const lineage = { sessionId: "sess_1", threadId: "thread_1" };
      recordAt(0, "team", "search", "search-1", [forecast], {
        ...lineage,
        requestId: "exchange-request-1",
      });
      recordAt(0, "team", "library", "scrape-9", [forecast], lineage);
      expect([...store.entries()]).toEqual([
        [
          `alexandria:discovered:${JSON.stringify(["search", "team", forecast.provider, forecast.capability])}`,
          JSON.stringify({ id: "search-1", at: START }),
        ],
      ]);

      vi.spyOn(Date, "now").mockReturnValue(START + 40_000);
      expect(await discoveryForCalls("team", [forecast], lineage)).toEqual([
        { discovery: { search: { id: "search-1", secondsBefore: 40 } } },
      ]);
      // One call, the three sources, the team only.
      expect(mget.mock.calls[0][0]).toHaveLength(3);
    });

    it("reads no tools out of a library command", () => {
      expect(
        libraryCommandTools(
          "cat /library/weather/open-meteo/forecast/daily.md",
          "/library/weather/open-meteo/geocoding/search.md\n",
        ),
      ).toEqual([]);
    });

    it("names no search for entries recorded while it was on", async () => {
      config.ALEXANDRIA_SEARCH_CONTEXT_ENABLED = true;
      recordAt(0, "team", "search", "search-1", [forecast]);
      config.ALEXANDRIA_SEARCH_CONTEXT_ENABLED = false;
      expect(await searchAt(5)).toEqual([undefined]);
    });
  });
});

describe("libraryCommandTools", () => {
  it("lists contracts named in the command first, then those in its output", () => {
    expect(
      libraryCommandTools(
        "cat /library/weather/open-meteo/forecast/daily.md",
        "See also /library/weather/open-meteo/geocoding/search.md and /library/finance/fred/series.md.\n",
      ),
    ).toEqual([
      { provider: "open-meteo", capability: "forecast/daily", rank: 1 },
      { provider: "open-meteo", capability: "geocoding/search", rank: 2 },
      { provider: "fred", capability: "series", rank: 3 },
    ]);
  });

  it("reads grep output and counts a contract once", () => {
    expect(
      libraryCommandTools(
        'grep -rn "forecast" /library',
        [
          "/library/weather/open-meteo/forecast/daily.md:3:Daily forecast",
          "/library/weather/open-meteo/forecast/daily.md:9:forecast days",
          "/library/weather/open-meteo/geocoding/search.md:4:forecast city",
        ].join("\n"),
      ),
    ).toEqual([
      { provider: "open-meteo", capability: "forecast/daily", rank: 1 },
      { provider: "open-meteo", capability: "geocoding/search", rank: 2 },
    ]);
  });

  it("leaves out skills, readmes, folders and anything that is not a contract path", () => {
    expect(
      libraryCommandTools(
        "ls /library/weather/open-meteo; cat /library/skills/search/weather-lookup.md /library/README.md",
        [
          "/library/weather/README.md",
          "/library/weather/open-meteo/README.md",
          "/library/weather/open-meteo/forecast",
          "/library/weather/open-meteo/forecast/daily.mdx",
          "/examples/weather/open-meteo/forecast/daily.md",
          "forecast/daily.md",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it.each([
    [undefined, undefined],
    [null, 42],
    [{ command: "cat /library/weather/open-meteo/forecast/daily.md" }, []],
  ])(
    "lists nothing when the command or output is not text (%j, %j)",
    (command, stdout) => {
      expect(libraryCommandTools(command, stdout)).toEqual([]);
    },
  );

  it("stops at 50 tools per command", () => {
    const stdout = Array.from(
      { length: 80 },
      (_, i) => `/library/weather/provider-${i}/forecast.md`,
    ).join("\n");
    const tools = libraryCommandTools(
      "find /library -name forecast.md",
      stdout,
    );
    expect(tools).toHaveLength(50);
    expect(tools.at(-1)).toEqual({
      provider: "provider-49",
      capability: "forecast",
      rank: 50,
    });
  });
});
