import { beforeEach, expect, it, vi } from "vitest";

const store = vi.hoisted(() => new Map<string, string>());
const expiries = vi.hoisted(() => new Map<string, unknown[]>());
const failNextWrite = vi.hoisted(() => ({ value: false }));
const warn = vi.hoisted(() => vi.fn());
vi.mock("./logger", () => ({ logger: { warn } }));
vi.mock("../services/rate-limiter", () => ({
  redisRateLimitClient: {
    pipeline: () => {
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
    mget: async (keys: string[]) => keys.map(key => store.get(key) ?? null),
  },
}));
import {
  discoveryForCalls,
  recordDiscoveredTools,
} from "./alexandria-discovery";

beforeEach(() => {
  store.clear();
  expiries.clear();
  warn.mockClear();
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
  expect(found).toEqual({
    search: { id: "search-1", secondsBefore: expect.any(Number) },
    find_tools: { id: "scrape-2", secondsBefore: expect.any(Number) },
  });
  expect(missing).toEqual({});
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
  ).toEqual([{}, {}]);
});

it("treats a malformed entry as a miss without dropping the others", async () => {
  const tool = { provider: "fred", capability: "series/search" };
  recordDiscoveredTools("team", "search", "search-1", [tool]);
  await vi.waitFor(() => expect(store.size).toBe(1));
  const [searchKey] = store.keys();
  store.set(searchKey!.replace('"search"', '"find_tools"'), "not json");
  expect(await discoveryForCalls("team", [tool])).toEqual([
    { search: { id: "search-1", secondsBefore: expect.any(Number) } },
  ]);
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
