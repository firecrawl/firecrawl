import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  firebillCheck,
  firebillTrack,
  shouldRouteToFirebill,
} from "../firebill";
import {
  firebillCheckTotal,
  firebillRetryTotal,
  firebillTrackTotal,
} from "../metrics";

const { configState } = vi.hoisted(() => ({
  configState: {
    FIREBILL_URL: "https://firebill.test",
    FIREBILL_SECRET: "secret",
    FIREBILL_ORG_IDS: ["allow-listed-org"] as string[] | undefined,
    FIREBILL_ROLLOUT_PERCENT: 0,
  },
}));

vi.mock("../../../config", () => ({ config: configState }));
vi.mock("../../../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Built fresh per call: a Response body can only be read once, so a shared
// instance would make the second attempt look like a transport failure.
const ok = () =>
  new Response(JSON.stringify({ success: true }), { status: 200 });
const refused = () =>
  new Response(JSON.stringify({ success: false }), { status: 200 });

const params = {
  customerId: "org-1",
  entityId: "team-1",
  featureId: "CREDITS",
  value: 3,
  properties: {},
  idempotencyKey: "fc:track:scrape:job-1",
};

beforeEach(() => {
  configState.FIREBILL_URL = "https://firebill.test";
  configState.FIREBILL_SECRET = "secret";
  configState.FIREBILL_ORG_IDS = ["allow-listed-org"];
  configState.FIREBILL_ROLLOUT_PERCENT = 0;
  firebillTrackTotal.reset();
  firebillRetryTotal.reset();
  firebillCheckTotal.reset();
});
afterEach(() => vi.unstubAllGlobals());

describe("shouldRouteToFirebill", () => {
  it("routes the allowlist even at 0 percent", () => {
    expect(shouldRouteToFirebill("allow-listed-org")).toBe(true);
  });

  it("routes nobody else at 0 percent — the kill switch", () => {
    const others = Array.from({ length: 200 }, (_, i) => `other-${i}`);
    expect(others.some(orgId => shouldRouteToFirebill(orgId))).toBe(false);
  });

  it("routes roughly the configured share once ramped", () => {
    const orgs = Array.from({ length: 1000 }, (_, i) => `ramp-${i}`);
    configState.FIREBILL_ROLLOUT_PERCENT = 30;
    const share =
      (orgs.filter(orgId => shouldRouteToFirebill(orgId)).length /
        orgs.length) *
      100;
    expect(Math.abs(share - 30)).toBeLessThan(6);
  });

  it("ignores a non-object second argument, so callback use cannot route everyone", () => {
    // `orgs.filter(shouldRouteToFirebill)` would pass the array index as the
    // options argument. TypeScript rejects that now, but the runtime must be
    // safe too: destructuring a field off a number yields undefined.
    configState.FIREBILL_ROLLOUT_PERCENT = 0;
    const asCallback = shouldRouteToFirebill as unknown as (
      orgId: string,
      index: number,
    ) => boolean;
    expect(asCallback("not-allow-listed", 7)).toBe(false);
  });

  it("stays off entirely when firebill is not configured", () => {
    configState.FIREBILL_ROLLOUT_PERCENT = 100;
    configState.FIREBILL_SECRET = "";
    expect(shouldRouteToFirebill("allow-listed-org")).toBe(false);
  });
});

describe("firebillTrack", () => {
  it("retries a refusal and reports success if the retry lands", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => refused())
      .mockImplementationOnce(async () => ok());
    vi.stubGlobal("fetch", fetchMock);

    await expect(firebillTrack(params)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Same key on both attempts, which is what makes the retry safe.
    const keys = fetchMock.mock.calls.map(
      c => JSON.parse(c[1].body).idempotency_key,
    );
    expect(keys).toEqual([params.idempotencyKey, params.idempotencyKey]);
  });

  it("gives up after the attempt limit and reports false", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => refused());
    vi.stubGlobal("fetch", fetchMock);

    await expect(firebillTrack(params)).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reuses one key across attempts even when the caller supplies none", async () => {
    // Without this the retry is a second event: firebill mints its own key per
    // request, so an accepted-but-lost first attempt would be billed twice.
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockImplementationOnce(async () => ok());
    vi.stubGlobal("fetch", fetchMock);

    await firebillTrack({ ...params, idempotencyKey: undefined });

    const keys = fetchMock.mock.calls.map(
      c => JSON.parse(c[1].body).idempotency_key,
    );
    expect(keys[0]).toBeTruthy();
    expect(keys[0]).toBe(keys[1]);
  });

  it("mints a different key for each keyless call", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ok());
    vi.stubGlobal("fetch", fetchMock);

    await firebillTrack({ ...params, idempotencyKey: undefined });
    await firebillTrack({ ...params, idempotencyKey: undefined });

    const [first, second] = fetchMock.mock.calls.map(
      c => JSON.parse(c[1].body).idempotency_key,
    );
    expect(first).not.toBe(second);
  });

  it("separates an explicit refusal from an ambiguous transport failure", async () => {
    const outcomes = async () =>
      Object.fromEntries(
        (await firebillTrackTotal.get()).values.map(v => [
          v.labels.outcome,
          v.value,
        ]),
      );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => refused()),
    );
    await firebillTrack(params);
    expect(await outcomes()).toEqual({ refused: 1 });

    firebillTrackTotal.reset();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
    await firebillTrack(params);
    // A timeout is not proof the usage was lost — firebill may have taken it.
    expect(await outcomes()).toEqual({ ambiguous: 1 });
  });

  it("retries a thrown error too", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockImplementationOnce(async () => ok());
    vi.stubGlobal("fetch", fetchMock);

    await expect(firebillTrack(params)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends a refund to /v1/refund with the value made positive", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ok());
    vi.stubGlobal("fetch", fetchMock);

    await firebillTrack({ ...params, value: -7 });
    expect(fetchMock.mock.calls[0][0]).toBe("https://firebill.test/v1/refund");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).value).toBe(7);
  });
});

describe("firebillCheck", () => {
  const checkParams = {
    customerId: "org-1",
    entityId: "team-1",
    featureId: "CREDITS",
    value: 10,
    properties: { source: "checkCreditsMiddleware" },
  };

  const answer = (body: unknown, status = 200) =>
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })),
    );

  it("passes through a yes, with the funder's pool as remaining", async () => {
    answer({ success: true, allowed: true, remaining: 500 });
    await expect(firebillCheck(checkParams)).resolves.toEqual({
      status: "answered",
      allowed: true,
      remaining: 500,
    });
  });

  it("passes through a no — this is the only thing that may 402", async () => {
    answer({ success: true, allowed: false, remaining: 3 });
    await expect(firebillCheck(checkParams)).resolves.toEqual({
      status: "answered",
      allowed: false,
      remaining: 3,
    });
  });

  // The asymmetry with firebillTrack, which fails closed. Refusing to answer an
  // authorization question must not become a 402.
  it.each([
    ["firebill could not answer", { success: false }, 200],
    ["a non-OK response", { success: true, allowed: true }, 503],
    ["a missing allowed", { success: true }, 200],
    ["a non-boolean allowed", { success: true, allowed: "yes" }, 200],
  ])("fails open on %s", async (_label, body, status) => {
    answer(body, status);
    await expect(firebillCheck(checkParams)).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("fails open when the request throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    await expect(firebillCheck(checkParams)).resolves.toEqual({
      status: "unavailable",
    });
  });

  // A missing figure must not read as zero: callers clamp crawl limits with
  // it, so zero would silently shrink an allowed crawl to nothing.
  it("treats an absent remaining as unbounded, not as zero", async () => {
    answer({ success: true, allowed: true });
    await expect(firebillCheck(checkParams)).resolves.toEqual({
      status: "answered",
      allowed: true,
      remaining: Infinity,
    });
  });

  it("sends the caller's context so Autumn records the decision", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ success: true, allowed: true, remaining: 1 }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await firebillCheck(checkParams);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://firebill.test/v1/check");
    expect(JSON.parse(init.body)).toEqual({
      customer_id: "org-1",
      entity_id: "team-1",
      feature_id: "CREDITS",
      value: 10,
      properties: { source: "checkCreditsMiddleware" },
    });
  });

  it("does not retry — this is on the request path", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("boom"));
    vi.stubGlobal("fetch", fetchMock);
    await firebillCheck(checkParams);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
