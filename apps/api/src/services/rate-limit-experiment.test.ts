import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  /** What the Redis mock holds, so a test sees stored assignments and markers. */
  store: new Map<string, string>(),
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  expire: vi.fn(),
  evaluate: vi.fn(),
  capture: vi.fn(),
  enabled: vi.fn(),
  distinctId: vi.fn(),
}));

vi.mock("./redis", () => ({
  redisEvictConnection: {
    get: mocks.get,
    set: mocks.set,
    del: mocks.del,
    expire: mocks.expire,
  },
}));
vi.mock("./posthog-capture", () => ({
  evaluatePostHogFlag: mocks.evaluate,
  capturePostHog: mocks.capture,
  isPostHogCaptureEnabled: mocks.enabled,
}));
vi.mock("./posthog", () => ({ resolveDistinctId: mocks.distinctId }));

import { getRateLimitExperimentVariant } from "./rate-limit-experiment";

/** Let the fire-and-forget tasks run. */
const settle = () => new Promise(resolve => setImmediate(resolve));

const caller = (orgId: string) => ({
  orgId,
  teamId: "team-1",
  apiKeyId: 7,
  rateLimitMultiplier: 10,
  isPaidPlan: true,
});
const assignmentKey = (orgId: string) =>
  `firecrawl:rate_limit_experiment:${orgId}`;

beforeEach(() => {
  mocks.store.clear();
  mocks.enabled.mockReturnValue(true);
  mocks.get.mockImplementation(async (key: string) => mocks.store.get(key));
  mocks.set.mockImplementation(async (key: string, value: string, ...args) => {
    if (args.includes("NX") && mocks.store.has(key)) return null;
    mocks.store.set(key, value);
    return "OK";
  });
  mocks.del.mockImplementation(async (key: string) =>
    mocks.store.delete(key) ? 1 : 0,
  );
  mocks.evaluate.mockResolvedValue({
    status: "resolved",
    variant: "treatment",
  });
  mocks.expire.mockResolvedValue(1);
  mocks.capture.mockResolvedValue(true);
  mocks.distinctId.mockResolvedValue("owner@example.com");
});

afterEach(async () => {
  // A test must not leave an exposure send running into the next one.
  await settle();
  vi.useRealTimers();
  vi.clearAllMocks();
});

// The module keeps per-process caches for the life of the process, so each
// test uses its own org id.
describe("getRateLimitExperimentVariant", () => {
  it("asks PostHog for the org's variant once, stores it, and sends the exposure with the plan", async () => {
    await expect(
      getRateLimitExperimentVariant(caller("org-new")),
    ).resolves.toBe("treatment");
    await settle();

    // The flag buckets on the org, so the read needs no DB lookup.
    expect(mocks.evaluate).toHaveBeenCalledExactlyOnceWith(
      "higher-rate-limits",
      "org-new",
      { company: "org-new" },
    );
    expect(mocks.distinctId).toHaveBeenCalledExactlyOnceWith("team-1", 7);
    expect(JSON.parse(mocks.store.get(assignmentKey("org-new"))!)).toEqual({
      variant: "treatment",
      checkedAt: expect.any(Number),
    });
    expect(mocks.capture).toHaveBeenCalledExactlyOnceWith(
      "$feature_flag_called",
      "owner@example.com",
      {
        $feature_flag: "higher-rate-limits",
        $feature_flag_response: "treatment",
        team_id: "team-1",
        rate_limit_multiplier: 10,
        is_paid_plan: true,
        $groups: { company: "org-new", team: "team-1" },
      },
    );

    // The marker is short-lived until PostHog accepts the event.
    expect(mocks.set).toHaveBeenCalledWith(
      "firecrawl:rate_limit_experiment_exposure:org-new:treatment",
      "1",
      "EX",
      5 * 60,
      "NX",
    );
    expect(mocks.expire).toHaveBeenCalledExactlyOnceWith(
      "firecrawl:rate_limit_experiment_exposure:org-new:treatment",
      30 * 24 * 60 * 60,
    );

    await getRateLimitExperimentVariant(caller("org-new"));
    await settle();
    expect(mocks.evaluate).toHaveBeenCalledTimes(1);
    expect(mocks.capture).toHaveBeenCalledTimes(1);
  });

  it("reads a fresh stored assignment without asking PostHog", async () => {
    mocks.store.set(
      assignmentKey("org-stored"),
      JSON.stringify({ variant: "control", checkedAt: Date.now() }),
    );

    await expect(
      getRateLimitExperimentVariant(caller("org-stored")),
    ).resolves.toBe("control");
    await settle();
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });

  it("treats a malformed stored assignment as missing", async () => {
    mocks.store.set(
      assignmentKey("org-malformed"),
      JSON.stringify({ variant: "test", checkedAt: Date.now() }),
    );

    await expect(
      getRateLimitExperimentVariant(caller("org-malformed")),
    ).resolves.toBe("treatment");
    await settle();
    expect(mocks.evaluate).toHaveBeenCalledTimes(1);
  });

  it("serves a stale assignment while it re-reads PostHog in the background", async () => {
    mocks.store.set(
      assignmentKey("org-stale"),
      JSON.stringify({ variant: "treatment", checkedAt: 0 }),
    );
    // Paused in PostHog since the org was assigned.
    mocks.evaluate.mockResolvedValue({ status: "disabled" });

    await expect(
      getRateLimitExperimentVariant(caller("org-stale")),
    ).resolves.toBe("treatment");
    await settle();

    expect(mocks.evaluate).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mocks.store.get(assignmentKey("org-stale"))!)).toEqual({
      variant: null,
      checkedAt: expect.any(Number),
    });
    await expect(
      getRateLimitExperimentVariant(caller("org-stale")),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["the flag is off or paused", "org-off", { status: "disabled" }],
    [
      "PostHog serves an unknown variant",
      "org-unknown",
      { status: "resolved", variant: "x" },
    ],
  ])("enrolls nobody when %s, and stores that", async (_label, org, result) => {
    mocks.evaluate.mockResolvedValue(result);

    await expect(getRateLimitExperimentVariant(caller(org))).resolves.toBe(
      undefined,
    );
    await settle();

    expect(mocks.capture).not.toHaveBeenCalled();
    expect(JSON.parse(mocks.store.get(assignmentKey(org))!).variant).toBe(null);
  });

  it("keeps the current limits on a transient failure and retries a minute later", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    mocks.evaluate.mockResolvedValueOnce({ status: "retryable" });

    await expect(
      getRateLimitExperimentVariant(caller("org-flaky")),
    ).resolves.toBeUndefined();
    expect(mocks.store.has(assignmentKey("org-flaky"))).toBe(false);

    await getRateLimitExperimentVariant(caller("org-flaky"));
    expect(mocks.evaluate).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(61_000);
    await expect(
      getRateLimitExperimentVariant(caller("org-flaky")),
    ).resolves.toBe("treatment");
    await settle();
    expect(mocks.evaluate).toHaveBeenCalledTimes(2);
  });

  it("asks PostHog once for concurrent first requests", async () => {
    await Promise.all([
      getRateLimitExperimentVariant(caller("org-burst")),
      getRateLimitExperimentVariant(caller("org-burst")),
      getRateLimitExperimentVariant(caller("org-burst")),
    ]);
    await settle();

    expect(mocks.evaluate).toHaveBeenCalledTimes(1);
    expect(mocks.capture).toHaveBeenCalledTimes(1);
  });

  it("keeps an accepted exposure reported when extending its marker fails", async () => {
    mocks.expire.mockRejectedValueOnce(new Error("redis down"));

    await getRateLimitExperimentVariant(caller("org-expire"));
    await settle();
    await getRateLimitExperimentVariant(caller("org-expire"));
    await settle();

    expect(mocks.capture).toHaveBeenCalledTimes(1);
  });

  it("does not resend an exposure another process holds, but checks again once its marker could expire", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const marker =
      "firecrawl:rate_limit_experiment_exposure:org-elsewhere:treatment";
    mocks.store.set(marker, "1");

    await getRateLimitExperimentVariant(caller("org-elsewhere"));
    await settle();
    await getRateLimitExperimentVariant(caller("org-elsewhere"));
    await settle();
    expect(mocks.set).toHaveBeenCalledTimes(2); // the assignment, one NX try
    expect(mocks.capture).not.toHaveBeenCalled();

    // That process's send failed and released the marker.
    mocks.store.delete(marker);
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    await getRateLimitExperimentVariant(caller("org-elsewhere"));
    await settle();
    expect(mocks.capture).toHaveBeenCalledTimes(1);
  });

  it("serves the variant PostHog assigned even when storing it fails", async () => {
    mocks.set.mockRejectedValueOnce(new Error("redis down"));

    await expect(
      getRateLimitExperimentVariant(caller("org-unstored")),
    ).resolves.toBe("treatment");
    await settle();
    await expect(
      getRateLimitExperimentVariant(caller("org-unstored")),
    ).resolves.toBe("treatment");
    expect(mocks.evaluate).toHaveBeenCalledTimes(1);
  });

  it("does not hold the request while Redis stalls storing the assignment", async () => {
    mocks.set.mockReturnValueOnce(new Promise(() => {}));

    const start = Date.now();
    await expect(
      getRateLimitExperimentVariant(caller("org-stalled-store")),
    ).resolves.toBe("treatment");
    expect(Date.now() - start).toBeLessThan(400);
  });

  it("keeps the current limits while Redis stalls on a first read, and asks PostHog in the background", async () => {
    mocks.get.mockReturnValueOnce(new Promise(() => {}));

    const start = Date.now();
    await expect(
      getRateLimitExperimentVariant(caller("org-stalled-read")),
    ).resolves.toBeUndefined();
    expect(Date.now() - start).toBeLessThan(400);
    await settle();

    expect(mocks.evaluate).toHaveBeenCalledTimes(1);
    await expect(
      getRateLimitExperimentVariant(caller("org-stalled-read")),
    ).resolves.toBe("treatment");
  });

  it("keeps an org's last variant while Redis stalls, even if PostHog fails too", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    mocks.store.set(
      assignmentKey("org-stalled-known"),
      JSON.stringify({ variant: "treatment", checkedAt: Date.now() }),
    );
    await getRateLimitExperimentVariant(caller("org-stalled-known"));
    await settle();

    vi.advanceTimersByTime(61_000);
    mocks.get.mockReturnValueOnce(new Promise(() => {}));
    mocks.evaluate.mockResolvedValueOnce({ status: "retryable" });
    await expect(
      getRateLimitExperimentVariant(caller("org-stalled-known")),
    ).resolves.toBe("treatment");
    await settle();
    expect(mocks.evaluate).toHaveBeenCalledTimes(1);
  });

  it("releases the exposure marker when PostHog rejects it, and retries after a wait", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    mocks.capture.mockResolvedValueOnce(false);
    mocks.store.set(
      assignmentKey("org-retry"),
      JSON.stringify({ variant: "control", checkedAt: Date.now() }),
    );
    const marker = "firecrawl:rate_limit_experiment_exposure:org-retry:control";

    await getRateLimitExperimentVariant(caller("org-retry"));
    await settle();
    expect(mocks.store.has(marker)).toBe(false);
    await getRateLimitExperimentVariant(caller("org-retry"));
    await settle();
    expect(mocks.capture).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    await getRateLimitExperimentVariant(caller("org-retry"));
    await settle();
    expect(mocks.capture).toHaveBeenCalledTimes(2);
    expect(mocks.expire).toHaveBeenCalledTimes(1);
    expect(mocks.store.has(marker)).toBe(true);
  });

  it("does nothing while PostHog is off", async () => {
    mocks.enabled.mockReturnValue(false);

    await expect(
      getRateLimitExperimentVariant(caller("org-no-posthog")),
    ).resolves.toBeUndefined();
    expect(mocks.evaluate).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
  });
});
