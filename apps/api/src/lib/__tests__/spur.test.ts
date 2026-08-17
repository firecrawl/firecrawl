import type { Mock } from "vitest";
import { isKeylessIpSuspicious } from "../spur";
import { redisRateLimitClient } from "../../services/rate-limiter";
import { config } from "../../config";
import { logger } from "../logger";

vi.mock("../../config", () => ({
  config: { SPUR_API_KEY: "test-key" },
}));

vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../services/rate-limiter", () => ({
  redisRateLimitClient: { get: vi.fn(), set: vi.fn(), eval: vi.fn() },
}));

// Minimal in-memory Redis backing the mock: enough SET semantics (NX guard,
// ignored EX/PX) for the single-flight lock and the result cache.
function installFakeRedis(): Map<string, string> {
  const store = new Map<string, string>();
  (redisRateLimitClient.get as Mock).mockImplementation(async (k: string) =>
    store.has(k) ? store.get(k)! : null,
  );
  (redisRateLimitClient.set as Mock).mockImplementation(
    async (k: string, v: string, ...args: unknown[]) => {
      if (args.includes("NX") && store.has(k)) return null;
      store.set(k, v);
      return "OK";
    },
  );
  // Atomic compare-and-delete used by releaseLock: KEYS[1]=lock key, ARGV[1]=token.
  (redisRateLimitClient.eval as Mock).mockImplementation(
    async (_script: string, _numKeys: number, key: string, token: string) => {
      if (store.get(key) === token) {
        store.delete(key);
        return 1;
      }
      return 0;
    },
  );
  return store;
}

function mockFetch(impl: () => Promise<unknown>): Mock {
  const fn = vi.fn(async () => impl());
  vi.stubGlobal("fetch", fn);
  return fn;
}

const okResponse = (body: unknown) => ({ ok: true, json: async () => body });

describe("Spur keyless IP reputation", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    config.SPUR_API_KEY = "test-key";
    store = installFakeRedis();
  });

  it("flags an IP fronting a live VPN/proxy tunnel", async () => {
    mockFetch(async () =>
      okResponse({ ip: "1.2.3.4", tunnels: [{ type: "VPN" }] }),
    );
    expect(await isKeylessIpSuspicious("1.2.3.4")).toBe(true);
  });

  it("allows a clean (datacenter-only) IP", async () => {
    mockFetch(async () =>
      okResponse({ ip: "1.2.3.5", infrastructure: "DATACENTER", risks: [] }),
    );
    expect(await isKeylessIpSuspicious("1.2.3.5")).toBe(false);
  });

  it("flags residential-proxy and explicit proxy/tunnel risk contexts", async () => {
    mockFetch(async () =>
      okResponse({ ip: "1.2.3.10", client: { proxies: ["RESIDENTIAL"] } }),
    );
    expect(await isKeylessIpSuspicious("1.2.3.10")).toBe(true);

    mockFetch(async () =>
      okResponse({ ip: "1.2.3.11", risks: ["CALLBACK_PROXY"] }),
    );
    expect(await isKeylessIpSuspicious("1.2.3.11")).toBe(true);
  });

  it("does not flag geo-mismatch / datacenter-only signals", async () => {
    mockFetch(async () =>
      okResponse({
        ip: "1.2.3.12",
        infrastructure: "DATACENTER",
        risks: ["GEO_MISMATCH"],
      }),
    );
    expect(await isKeylessIpSuspicious("1.2.3.12")).toBe(false);
  });

  it("collapses a concurrent burst from one IP into a single Spur call", async () => {
    // Winner's fetch resolves after a tick so the other callers are guaranteed
    // to miss the lock and fall into the waiter path.
    const fetchFn = mockFetch(
      () =>
        new Promise(resolve =>
          setTimeout(
            () => resolve(okResponse({ ip: "1.2.3.6", risks: [] })),
            50,
          ),
        ),
    );

    const results = await Promise.all(
      Array.from({ length: 5 }, () => isKeylessIpSuspicious("1.2.3.6")),
    );

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(results).toEqual([false, false, false, false, false]);
  });

  it("fails open on a non-200 Spur response and caches nothing", async () => {
    const fetchFn = mockFetch(async () => ({ ok: false, status: 429 }));
    expect(await isKeylessIpSuspicious("1.2.3.7")).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(store.has("spur_context:1.2.3.7")).toBe(false);
  });

  it("fails open when the Spur call throws, and releases the lock so a later call retries", async () => {
    const fetchFn = mockFetch(async () => {
      throw new Error("network down");
    });
    expect(await isKeylessIpSuspicious("1.2.3.8")).toBe(false);

    // Lock must be freed: a subsequent call gets to fetch again.
    fetchFn.mockImplementation(async () =>
      okResponse({ ip: "1.2.3.8", tunnels: [{ type: "TOR" }] }),
    );
    expect(await isKeylessIpSuspicious("1.2.3.8")).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("a lock loser fails open within the bound when no result ever lands", async () => {
    // Pre-hold the lock under a different token so this caller can never win it,
    // and never populate the cache → it must give up (bounded) and fail open
    // without ever hitting Spur.
    store.set("spur_lock:9.9.9.9", "held-by-someone-else");
    const fetchFn = mockFetch(async () =>
      okResponse({ tunnels: [{ type: "VPN" }] }),
    );

    const start = Date.now();
    const result = await isKeylessIpSuspicious("9.9.9.9");
    const elapsed = Date.now() - start;

    expect(result).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
    // Bounded wait: it gives up around LOCK_WAIT_MS, never hangs indefinitely.
    expect(elapsed).toBeGreaterThanOrEqual(3000);
    expect(elapsed).toBeLessThan(8000);
  });

  it("fails open and flags timedOut when the Spur call times out", async () => {
    mockFetch(async () => {
      // Shape of what AbortSignal.timeout rejects with.
      const err = new Error("The operation timed out.");
      err.name = "TimeoutError";
      throw err;
    });

    expect(await isKeylessIpSuspicious("1.2.3.13")).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      "Spur context lookup failed; failing open",
      expect.objectContaining({ ip: "1.2.3.13", timedOut: true }),
    );
  });

  it("is a no-op (and never calls Spur) when SPUR_API_KEY is unset", async () => {
    config.SPUR_API_KEY = undefined;
    const fetchFn = mockFetch(async () => okResponse({ tunnels: [{}] }));
    expect(await isKeylessIpSuspicious("1.2.3.9")).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
