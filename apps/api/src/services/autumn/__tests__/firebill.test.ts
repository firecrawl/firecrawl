import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  firebillCheck,
  firebillFinalize,
  firebillLock,
  firebillTrack,
  shouldRouteToFirebill,
} from "../firebill";
import { logger } from "../../../lib/logger";
import {
  firebillCheckTotal,
  firebillFailureCauseTotal,
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
/** firebill's confirm timed out: it does not know whether it took the event. */
const ambiguous = () =>
  new Response(JSON.stringify({ success: false, ambiguous: true }), {
    status: 504,
  });

/** What undici actually throws: the real error nested under a bare TypeError. */
const wrapped = (inner: Error) =>
  Object.assign(new TypeError("fetch failed"), { cause: inner });

const abortError = () =>
  Object.assign(new Error("The operation was aborted due to timeout"), {
    name: "TimeoutError",
  });

const connectionError = (code: string) =>
  Object.assign(new Error(`connect ${code} 10.0.0.1:8080`), { code });

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
  firebillFailureCauseTotal.reset();
  vi.mocked(logger.info).mockClear();
  vi.mocked(logger.warn).mockClear();
  vi.mocked(logger.error).mockClear();
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

/**
 * The outcome counter alone — the one the alerts read, which must keep exactly
 * the labels it always had.
 */
const trackOutcomes = async () =>
  Object.fromEntries(
    (await firebillTrackTotal.get()).values.map(v => [
      v.labels.outcome,
      v.value,
    ]),
  );

const checkOutcomes = async () =>
  Object.fromEntries(
    (await firebillCheckTotal.get()).values.map(v => [
      v.labels.outcome,
      v.value,
    ]),
  );

/** The separate cause counter, as `operation/cause`. */
const failureCauses = async () =>
  Object.fromEntries(
    (await firebillFailureCauseTotal.get()).values.map(v => [
      `${v.labels.operation}/${v.labels.cause}`,
      v.value,
    ]),
  );

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
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => refused()),
    );
    await firebillTrack(params);
    expect(await trackOutcomes()).toEqual({ refused: 1 });
    expect(await failureCauses()).toEqual({ "track/refused": 1 });

    firebillTrackTotal.reset();
    firebillFailureCauseTotal.reset();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
    await firebillTrack(params);
    // A timeout is not proof the usage was lost — firebill may have taken it.
    expect(await trackOutcomes()).toEqual({ ambiguous: 1 });
    expect(await failureCauses()).toEqual({ "track/connection": 1 });
  });

  // -----------------------------------------------------------------------
  // The alerts' own series
  // -----------------------------------------------------------------------

  it("leaves the alerted counters with exactly the labels they had", async () => {
    // `increase()` evaluates per series, so a `cause` label here would turn
    // `increase(firecrawl_firebill_track_total{outcome="refused"}[15m]) > 0`
    // into one threshold per cause. The detail lives beside it instead.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => refused()),
    );
    await firebillTrack(params);

    const [series] = (await firebillTrackTotal.get()).values;
    expect(Object.keys(series.labels).sort()).toEqual(["operation", "outcome"]);

    const [cause] = (await firebillFailureCauseTotal.get()).values;
    expect(Object.keys(cause.labels).sort()).toEqual(["cause", "operation"]);
    expect(cause.labels).toMatchObject({
      operation: "track",
      cause: "refused",
    });
  });

  it("counts a refund's cause under its own operation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => refused()),
    );
    await firebillTrack({ ...params, value: -7 });
    expect(await failureCauses()).toEqual({ "refund/refused": 1 });
  });

  // -----------------------------------------------------------------------
  // firebill saying "I do not know"
  //
  // A publish whose broker confirm timed out may have been taken anyway. Over
  // eight days ~2,100 of these were answered `{"success": false}` — the same
  // body a refusal sends — and every one of those events had in fact settled,
  // while this client logged each as usage that would never be billed.
  // -----------------------------------------------------------------------

  it.each([
    ["a 504 carrying the field", () => ambiguous()],
    ["a 504 with no body at all", () => new Response(null, { status: 504 })],
    [
      "a 200 that says so by field",
      () =>
        new Response(JSON.stringify({ success: false, ambiguous: true }), {
          status: 200,
        }),
    ],
  ])("reads %s as ambiguous, never as refused", async (_label, respond) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => respond()),
    );

    await expect(firebillTrack(params)).resolves.toBe(false);
    expect(await trackOutcomes()).toEqual({ ambiguous: 1 });
    expect(await failureCauses()).toEqual({ "track/ambiguous": 1 });
  });

  // **An answer we cannot read is not proof of anything.** firebill may have
  // taken the event and said so in a shape we did not understand, so calling it
  // `refused` would log billed usage as lost — the same class of untruth this
  // PR exists to remove, one layer down.
  it.each([
    ["an empty 200", () => new Response("", { status: 200 })],
    [
      "a 200 that is not JSON",
      () => new Response("<html>502</html>", { status: 200 }),
    ],
    [
      "a 200 with no success field",
      () => new Response(JSON.stringify({ queued: true }), { status: 200 }),
    ],
    [
      "a 200 whose success is not a boolean",
      () => new Response(JSON.stringify({ success: "yes" }), { status: 200 }),
    ],
  ])("reads %s as unusable, not as a refusal", async (_label, respond) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => respond()),
    );

    await expect(firebillTrack(params)).resolves.toBe(false);
    expect(await trackOutcomes()).toEqual({ ambiguous: 1 });
    expect(await failureCauses()).toEqual({ "track/unusable": 1 });
    expect(vi.mocked(logger.error).mock.calls.map(c => c[0])).not.toContain(
      "firebill refused a usage event; it will not be billed",
    );
  });

  it("still reads success:false as a refusal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => refused()),
    );

    await expect(firebillTrack(params)).resolves.toBe(false);
    expect(await trackOutcomes()).toEqual({ refused: 1 });
  });

  // A body that never finished arriving is the network failing, not firebill
  // answering — it has to reach the transport classifier, not be swallowed as
  // an unusable body.
  it("treats a body that dies mid-read as a transport failure", async () => {
    const dying = () => {
      const response = new Response(JSON.stringify({ success: true }), {
        status: 200,
      });
      vi.spyOn(response, "json").mockRejectedValue(
        Object.assign(new TypeError("terminated"), {
          cause: Object.assign(new Error("aborted"), {
            code: "UND_ERR_BODY_TIMEOUT",
          }),
        }),
      );
      return response;
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => dying()),
    );

    await expect(firebillTrack(params)).resolves.toBe(false);
    expect(await failureCauses()).toEqual({ "track/timeout": 1 });
    expect(vi.mocked(logger.warn).mock.calls.map(c => c[0])).toContain(
      "firebill track request did not complete — client-side timeout or connection error; firebill did not answer",
    );
  });

  it("logs an ambiguous answer as unknown rather than as unbilled usage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => ambiguous()),
    );

    await firebillTrack(params);

    const messages = vi.mocked(logger.error).mock.calls.map(c => c[0]);
    expect(messages).toContain(
      "firebill did not answer; the event may or may not have been accepted",
    );
    expect(messages).not.toContain(
      "firebill refused a usage event; it will not be billed",
    );
  });

  // -----------------------------------------------------------------------
  // Whose failure was it
  //
  // ~1,800 warnings per 30h said "firebill may be unavailable" against a
  // firebill whose server-side p99 was 73ms. They were our own 5s deadline.
  // -----------------------------------------------------------------------

  it.each([
    ["our own deadline firing", () => abortError(), "timeout"],
    ["an undici-wrapped deadline", () => wrapped(abortError()), "timeout"],
    [
      "a refused connection",
      () => wrapped(connectionError("ECONNREFUSED")),
      "connection",
    ],
    [
      "a reset connection",
      () => wrapped(connectionError("ECONNRESET")),
      "connection",
    ],
    [
      "a DNS failure",
      () => wrapped(connectionError("ENOTFOUND")),
      "connection",
    ],
  ])("labels %s as a client-side %s", async (_label, error, cause) => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error()));

    await expect(firebillTrack(params)).resolves.toBe(false);
    expect(await trackOutcomes()).toEqual({ ambiguous: 1 });
    expect(await failureCauses()).toEqual({ [`track/${cause}`]: 1 });
  });

  it("stops blaming firebill for a request that never reached it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(wrapped(abortError())));

    await firebillTrack(params);

    // The logger's own overloads make `calls` a one-element tuple to TS; every
    // call site here passes (message, fields).
    const warnings = vi.mocked(logger.warn).mock.calls as unknown as [
      string,
      Record<string, unknown>,
    ][];
    const messages = warnings.map(c => c[0]);
    expect(messages).toContain(
      "firebill track request did not complete — client-side timeout or connection error; firebill did not answer",
    );
    expect(messages.join(" ")).not.toContain("firebill may be unavailable");
    // The error's own identity, so the class of stall is greppable.
    // The innermost error's identity, not the `TypeError: fetch failed` undici
    // wraps it in — so the class of stall is greppable.
    expect(warnings[0][1]).toMatchObject({
      cause: "timeout",
      errorName: "TimeoutError",
      timeoutMs: 5000,
    });
  });

  it("names the status when firebill really did answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(async () => new Response("nope", { status: 502 })),
    );

    await expect(firebillTrack(params)).resolves.toBe(false);
    expect(await trackOutcomes()).toEqual({ ambiguous: 1 });
    expect(await failureCauses()).toEqual({ "track/non_ok": 1 });
    // A static message; the status is context, so log search can group these.
    const [message, fields] = vi.mocked(logger.warn).mock
      .calls[0] as unknown as [string, Record<string, unknown>];
    expect(message).toBe(
      "firebill track attempt failed — firebill answered a non-OK status",
    );
    expect(fields).toMatchObject({ status: 502 });
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
  // The inverse of the case below, and the dangerous direction: the middleware
  // reads a denial with `remaining > 0` as a *partial* crawl and calls next(),
  // so an unbounded default would turn a refusal into an unlimited crawl.
  it("treats an absent remaining on a DENIAL as zero, not unbounded", async () => {
    answer({ success: true, allowed: false });
    await expect(firebillCheck(checkParams)).resolves.toEqual({
      status: "answered",
      allowed: false,
      remaining: 0,
    });
  });

  // A denial that *does* carry a figure keeps it: that is a legitimate partial
  // crawl, and the existing middleware behaviour we must not change.
  it("keeps a usable remaining on a denial", async () => {
    answer({ success: true, allowed: false, remaining: 25 });
    await expect(firebillCheck(checkParams)).resolves.toEqual({
      status: "answered",
      allowed: false,
      remaining: 25,
    });
  });

  it("treats an absent remaining on an ALLOWED check as unbounded, not zero", async () => {
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

  it.each([
    ["our own deadline firing", () => wrapped(abortError()), "check/timeout"],
    [
      "a refused connection",
      () => wrapped(connectionError("ECONNREFUSED")),
      "check/connection",
    ],
  ])(
    "blames the client, not firebill, for %s",
    async (_label, error, expected) => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error()));

      await expect(firebillCheck(checkParams)).resolves.toEqual({
        status: "unavailable",
      });
      expect(await checkOutcomes()).toEqual({ unavailable: 1 });
      expect(await failureCauses()).toEqual({ [expected]: 1 });
      expect(vi.mocked(logger.error).mock.calls.map(c => c[0])).toContain(
        "firebill check unavailable — the request did not complete (client-side timeout or connection error); firebill did not answer",
      );
    },
  );

  it("names the status in context when firebill answered one", async () => {
    answer({ success: true, allowed: true }, 503);

    await firebillCheck(checkParams);

    expect(await checkOutcomes()).toEqual({ unavailable: 1 });
    expect(await failureCauses()).toEqual({ "check/non_ok": 1 });
    const [message, fields] = vi.mocked(logger.error).mock
      .calls[0] as unknown as [string, Record<string, unknown>];
    expect(message).toBe(
      "firebill check unavailable — firebill answered a non-OK status",
    );
    expect(fields).toMatchObject({ status: 503 });
  });

  it("records no cause at all for a real answer", async () => {
    answer({ success: true, allowed: true, remaining: 500 });
    await firebillCheck(checkParams);
    expect(await checkOutcomes()).toEqual({ allowed: 1 });
    expect(await failureCauses()).toEqual({});
  });

  // `refused` is documented as an explicit `success: false`. An answer we could
  // not read is not one, and labelling it so would have anyone slicing by cause
  // counting unreadable answers as declines.
  it.each([
    ["a missing allowed", { success: true }, 200],
    ["a non-boolean allowed", { success: true, allowed: "yes" }, 200],
  ])("calls %s unusable rather than refused", async (_label, body, status) => {
    answer(body, status);
    await firebillCheck(checkParams);
    expect(await failureCauses()).toEqual({ "check/unusable": 1 });
  });

  it("calls an unreadable body unusable rather than refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response("<html>502</html>", { status: 200 })),
    );
    await expect(firebillCheck(checkParams)).resolves.toEqual({
      status: "unavailable",
    });
    expect(await failureCauses()).toEqual({ "check/unusable": 1 });
  });

  it("keeps refused for an explicit success:false", async () => {
    answer({ success: false });
    await firebillCheck(checkParams);
    expect(await failureCauses()).toEqual({ "check/refused": 1 });
  });

  it("does not retry — this is on the request path", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("boom"));
    vi.stubGlobal("fetch", fetchMock);
    await firebillCheck(checkParams);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("firebillLock", () => {
  const lockParams = {
    customerId: "org-1",
    entityId: "team-1",
    featureId: "CREDITS",
    value: 10,
    lockId: "monitor_check-1",
    expiresAt: Date.now() + 60_000,
  };

  const answer = (body: unknown, status = 200) =>
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })),
    );

  it("locks and carries the operation token back on a gated hold", async () => {
    answer({
      success: true,
      allowed: true,
      lock_id: "monitor_check-1",
      operation_token: "op-tok",
    });
    await expect(firebillLock(lockParams)).resolves.toEqual({
      status: "locked",
      lockId: "monitor_check-1",
      operationToken: "op-tok",
    });
  });

  it("falls back to the caller's lock id when firebill echoes none", async () => {
    answer({ success: true, allowed: true });
    await expect(firebillLock(lockParams)).resolves.toEqual({
      status: "locked",
      lockId: "monitor_check-1",
    });
  });

  it("reads a denial and its reason", async () => {
    answer({ success: true, allowed: false, reason: "out_of_credits" });
    await expect(firebillLock(lockParams)).resolves.toEqual({
      status: "denied",
      reason: "out_of_credits",
    });
  });

  it("drops an unrecognised denial reason rather than passing it through", async () => {
    answer({ success: true, allowed: false, reason: "some_new_reason" });
    await expect(firebillLock(lockParams)).resolves.toEqual({
      status: "denied",
    });
  });

  // A shape firebill sent on purpose (`success: false`) is `refused`; one we
  // could not read is `unusable`. Both proceed unlocked, but slicing the cause
  // counter must tell them apart.
  it("calls an explicit success:false refused", async () => {
    answer({ success: false });
    await expect(firebillLock(lockParams)).resolves.toEqual({
      status: "unavailable",
    });
    expect(await failureCauses()).toEqual({ "lock/refused": 1 });
  });

  it.each([
    ["a missing allowed", { success: true }],
    ["a non-boolean allowed", { success: true, allowed: "yes" }],
    ["a missing success", { locked: true }],
  ])("calls %s unusable, not refused", async (_label, body) => {
    answer(body);
    await expect(firebillLock(lockParams)).resolves.toEqual({
      status: "unavailable",
    });
    expect(await failureCauses()).toEqual({ "lock/unusable": 1 });
  });

  it("calls an unreadable body unusable", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response("<html>502</html>", { status: 200 })),
    );
    await expect(firebillLock(lockParams)).resolves.toEqual({
      status: "unavailable",
    });
    expect(await failureCauses()).toEqual({ "lock/unusable": 1 });
  });

  it("names a non-OK status as its own cause", async () => {
    answer({ success: true, allowed: true }, 503);
    await expect(firebillLock(lockParams)).resolves.toEqual({
      status: "unavailable",
    });
    expect(await failureCauses()).toEqual({ "lock/non_ok": 1 });
  });
});

describe("firebillFinalize", () => {
  const finalizeParams = {
    lockId: "monitor_check-1",
    action: "confirm" as const,
  };

  const answer = (body: unknown, status = 200) =>
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })),
    );

  it("returns true when firebill accepted the settle", async () => {
    answer({ success: true });
    await expect(firebillFinalize(finalizeParams)).resolves.toBe(true);
  });

  it("calls an explicit success:false refused", async () => {
    answer({ success: false });
    await expect(firebillFinalize(finalizeParams)).resolves.toBe(false);
    expect(await failureCauses()).toEqual({ "finalize/refused": 1 });
  });

  it.each([
    ["a missing success", { queued: true }],
    ["a non-boolean success", { success: "yes" }],
  ])("calls %s unusable, not refused", async (_label, body) => {
    answer(body);
    await expect(firebillFinalize(finalizeParams)).resolves.toBe(false);
    expect(await failureCauses()).toEqual({ "finalize/unusable": 1 });
  });

  it("calls an unreadable body unusable", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response("<html>502</html>", { status: 200 })),
    );
    await expect(firebillFinalize(finalizeParams)).resolves.toBe(false);
    expect(await failureCauses()).toEqual({ "finalize/unusable": 1 });
  });

  it("reads a 504 as ambiguous rather than refused", async () => {
    answer({ success: false, ambiguous: true }, 504);
    await expect(firebillFinalize(finalizeParams)).resolves.toBe(false);
    expect(await failureCauses()).toEqual({ "finalize/ambiguous": 1 });
  });
});
