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
vi.mock("./posthog", () => ({
  resolveDistinctId: async () => "owner@example.com",
}));

import { getRateLimitExperimentVariant } from "./rate-limit-experiment";

/** Let the fire-and-forget tasks run. */
const settle = () => new Promise(resolve => setImmediate(resolve));

const caller = (orgId: string) => ({ orgId, teamId: "team-1", apiKeyId: 7 });
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
  mocks.capture.mockResolvedValue(true);
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
  it("asks PostHog for the org's variant once, stores it, and sends the exposure", async () => {
    await expect(
      getRateLimitExperimentVariant(caller("org-new")),
    ).resolves.toBe("treatment");
    await settle();

    expect(mocks.evaluate).toHaveBeenCalledExactlyOnceWith(
      "higher-rate-limits",
      "owner@example.com",
      { company: "org-new" },
    );
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

  it("does not resend an exposure another process already sent", async () => {
    mocks.store.set(
      "firecrawl:rate_limit_experiment_exposure:org-elsewhere:treatment",
      "1",
    );

    await getRateLimitExperimentVariant(caller("org-elsewhere"));
    await settle();

    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("releases the exposure marker when PostHog rejects it, so a later request retries", async () => {
    mocks.capture.mockResolvedValueOnce(false);
    mocks.store.set(
      assignmentKey("org-retry"),
      JSON.stringify({ variant: "control", checkedAt: Date.now() }),
    );

    await getRateLimitExperimentVariant(caller("org-retry"));
    await settle();
    await getRateLimitExperimentVariant(caller("org-retry"));
    await settle();

    expect(mocks.capture).toHaveBeenCalledTimes(2);
    expect(mocks.expire).toHaveBeenCalledTimes(1);
    expect(
      mocks.store.has(
        "firecrawl:rate_limit_experiment_exposure:org-retry:control",
      ),
    ).toBe(true);
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
