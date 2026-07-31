import { vi, describe, it, expect, beforeEach, afterAll } from "vitest";

// Exercises the REAL Autumn clients from `../client` (no SDK mocking) against a
// stubbed transport that answers slower than the hot-path client's 2s budget.
//
// The mock-based tests in usage.test.ts can only assert which client a call is
// routed to; they cannot catch the actual defect, which is a timeout. This file
// covers it: the grouped `?byApiKey=true` aggregate takes several seconds
// against real Autumn, and the SDK's TimeoutFixHook intersects the client-level
// timeout with the request signal via `AbortSignal.any` — so a per-call
// `timeoutMs` can only ever shorten it. A 15s per-call override on the 2s
// hot-path client is a no-op, which is why historical usage needs its own
// client.
vi.hoisted(() => {
  process.env.AUTUMN_SECRET_KEY ??= "sk_test_usage_timeout";
});

const RESPONSE_DELAY_MS = 4000;

// One daily bin, one API key, so the grouped path has something to roll up.
const AGGREGATE_BODY = {
  list: [
    {
      period: Date.parse("2026-07-15T00:00:00.000Z"),
      values: { CREDITS: 12 },
      grouped_values: { CREDITS: { "101": 12 } },
    },
  ],
  total: { CREDITS: { count: 1, sum: 12 } },
};

vi.mock("../../../db/connection", () => ({
  get dbRr() {
    return {
      select: () => ({
        from: () => ({
          where: () =>
            // api_keys lookup awaits the builder; teams lookup calls .limit(1)
            Object.assign(Promise.resolve([{ id: 101, name: "Default" }]), {
              limit: () => Promise.resolve([{ org_id: "org-1" }]),
            }),
        }),
      }),
    };
  },
}));

// No Redis in unit tests: every rollup read is a miss, so each call goes
// through to the (stubbed) Autumn transport, which is what we want to time.
vi.mock("../../redis", () => ({
  getValue: async () => null,
  setValue: async () => undefined,
}));

import { getTeamHistoricalUsageByApiKey } from "../usage";
import { autumnClient } from "../client";

const realFetch = globalThis.fetch;

/**
 * Answers after RESPONSE_DELAY_MS, honouring whatever signal the SDK attached.
 *
 * The SDK currently calls `fetch(request)` with the signal on the Request, but
 * read it from the init argument too: if that ever changes, this stub must
 * still abort, or the timeout tests below would pass for the wrong reason (the
 * response arriving rather than the budget expiring).
 */
function slowFetch(input: any, init?: any): Promise<Response> {
  const signal: AbortSignal | undefined = input?.signal ?? init?.signal;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve(
        new Response(JSON.stringify(AGGREGATE_BODY), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }, RESPONSE_DELAY_MS);

    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
}

beforeEach(() => {
  globalThis.fetch = slowFetch as unknown as typeof fetch;
});

it("the stub actually sees the SDK's abort signal", async () => {
  // Guards the two timeout tests: if the stub could not observe a signal, they
  // would pass because the response arrived, not because the budget expired.
  let sawSignal = false;
  globalThis.fetch = ((input: any, init?: any) => {
    sawSignal = Boolean(input?.signal ?? init?.signal);
    return slowFetch(input, init);
  }) as unknown as typeof fetch;

  await expect(
    autumnClient!.events.aggregate({
      customerId: "org-1",
      entityId: "team-1",
      featureId: "CREDITS",
      binSize: "day",
      customRange: { start: 0, end: 1 },
    }),
  ).rejects.toThrow();

  expect(sawSignal).toBe(true);
}, 20000);

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("historical usage against a slow Autumn", () => {
  it("resolves byApiKey usage that takes longer than the hot-path budget", async () => {
    const periods = await getTeamHistoricalUsageByApiKey("team-1");

    // The stub answers every window with the same July bin, so the closed and
    // current slices both land in July — the assertion that matters here is
    // that the call completed at all rather than aborting at 2s.
    expect(periods.length).toBeGreaterThan(0);
    for (const period of periods) {
      expect(period.apiKey).toBe("Default");
      expect(period.creditsUsed).toBeGreaterThan(0);
    }
  }, 20000);

  // Guards the reason the dedicated client exists: on the hot-path client the
  // same call dies at ~2s even with a 15s per-call override, which is what
  // surfaced as a 500 on /team/credit-usage/historical?byApiKey=true.
  it("fails on the hot-path client even with a longer per-call timeout", async () => {
    const started = Date.now();
    await expect(
      autumnClient!.events.aggregate(
        {
          customerId: "org-1",
          entityId: "team-1",
          featureId: "CREDITS",
          binSize: "day",
          groupBy: "properties.apiKeyId",
          customRange: {
            start: Date.parse("2026-07-01T00:00:00.000Z"),
            end: Date.parse("2026-07-31T00:00:00.000Z"),
          },
        },
        { timeoutMs: 15000 },
      ),
    ).rejects.toThrow();

    expect(Date.now() - started).toBeLessThan(RESPONSE_DELAY_MS);
  }, 20000);
});
