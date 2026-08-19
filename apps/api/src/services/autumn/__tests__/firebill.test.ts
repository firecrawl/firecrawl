import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { firebillTrack, shouldRouteToFirebill } from "../firebill";
import { firebillRetryTotal, firebillTrackTotal } from "../metrics";

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
});
afterEach(() => vi.unstubAllGlobals());

describe("shouldRouteToFirebill", () => {
  it("routes the allowlist even at 0 percent", () => {
    expect(shouldRouteToFirebill("allow-listed-org")).toBe(true);
  });

  it("routes nobody else at 0 percent — the kill switch", () => {
    const others = Array.from({ length: 200 }, (_, i) => `other-${i}`);
    expect(others.some(shouldRouteToFirebill)).toBe(false);
  });

  it("routes roughly the configured share once ramped", () => {
    const orgs = Array.from({ length: 1000 }, (_, i) => `ramp-${i}`);
    configState.FIREBILL_ROLLOUT_PERCENT = 30;
    const share =
      (orgs.filter(shouldRouteToFirebill).length / orgs.length) * 100;
    expect(Math.abs(share - 30)).toBeLessThan(6);
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
