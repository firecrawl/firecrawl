import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  /** Redis keys the SET NX / DEL mocks hold, so a test sees the marker lifecycle. */
  markers: new Set<string>(),
  set: vi.fn(),
  del: vi.fn(),
  capturePostHog: vi.fn(),
  enabled: vi.fn(),
}));

vi.mock("./redis", () => ({
  redisEvictConnection: { set: mocks.set, del: mocks.del },
}));
vi.mock("./posthog-capture", () => ({
  capturePostHog: mocks.capturePostHog,
  isPostHogCaptureEnabled: mocks.enabled,
}));
// The api key owner's email for the person lookup, the org for the team.
vi.mock("../db/connection", () => ({
  dbRr: {
    select: (fields: Record<string, unknown>) => {
      const rows =
        "email" in fields
          ? [{ email: "owner@example.com" }]
          : [{ orgId: "org-1" }];
      const query = {
        from: () => query,
        leftJoin: () => query,
        where: () => query,
        limit: async () => rows,
      };
      return query;
    },
  },
}));

import { trackRateLimitExperimentExposure } from "./posthog";

/** Let the fire-and-forget task run. */
const settle = () => new Promise(resolve => setImmediate(resolve));

beforeEach(() => {
  mocks.enabled.mockReturnValue(true);
  mocks.markers.clear();
  mocks.set.mockImplementation(async (key: string) => {
    if (mocks.markers.has(key)) return null;
    mocks.markers.add(key);
    return "OK";
  });
  mocks.del.mockImplementation(async (key: string) =>
    mocks.markers.delete(key) ? 1 : 0,
  );
  mocks.capturePostHog.mockResolvedValue(true);
});

afterEach(() => {
  vi.clearAllMocks();
});

// The tracker remembers reported teams for the life of the process, so each
// test uses its own team id.
describe("trackRateLimitExperimentExposure", () => {
  it("sends the variant as the experiment exposure for the key owner", async () => {
    trackRateLimitExperimentExposure({
      teamId: "team-send",
      apiKeyId: 7,
      variant: "test",
    });
    await settle();

    expect(mocks.set).toHaveBeenCalledWith(
      "firecrawl:rate_limit_exposure:team-send:test",
      "1",
      "EX",
      30 * 24 * 60 * 60,
      "NX",
    );
    expect(mocks.capturePostHog).toHaveBeenCalledExactlyOnceWith(
      "rate_limit_experiment_exposure",
      "owner@example.com",
      {
        "$feature/rate-limit-minimum": "test",
        team_id: "team-send",
        $groups: { team: "team-send", company: "org-1" },
      },
    );
  });

  it("reports a team once, and skips Redis after the first report", async () => {
    const exposure = {
      teamId: "team-once",
      apiKeyId: 7,
      variant: "control",
    } as const;
    trackRateLimitExperimentExposure(exposure);
    await settle();
    trackRateLimitExperimentExposure(exposure);
    await settle();

    expect(mocks.set).toHaveBeenCalledTimes(1);
    expect(mocks.capturePostHog).toHaveBeenCalledTimes(1);
  });

  it("sends once for concurrent requests, and still retries if that send fails", async () => {
    mocks.capturePostHog.mockResolvedValueOnce(false);
    const exposure = { teamId: "team-concurrent", variant: "test" } as const;

    trackRateLimitExperimentExposure(exposure);
    trackRateLimitExperimentExposure(exposure);
    await settle();
    expect(mocks.set).toHaveBeenCalledTimes(1);
    expect(mocks.capturePostHog).toHaveBeenCalledTimes(1);

    trackRateLimitExperimentExposure(exposure);
    await settle();
    expect(mocks.capturePostHog).toHaveBeenCalledTimes(2);
  });

  it("does not resend an exposure another process already reported", async () => {
    mocks.markers.add("firecrawl:rate_limit_exposure:team-elsewhere:test");

    trackRateLimitExperimentExposure({
      teamId: "team-elsewhere",
      variant: "test",
    });
    await settle();

    expect(mocks.capturePostHog).not.toHaveBeenCalled();
  });

  it("reports the team again when it moves to the other variant", async () => {
    trackRateLimitExperimentExposure({ teamId: "team-moved", variant: "test" });
    await settle();
    trackRateLimitExperimentExposure({
      teamId: "team-moved",
      variant: "control",
    });
    await settle();

    expect(
      mocks.capturePostHog.mock.calls.map(
        ([, , properties]) => properties["$feature/rate-limit-minimum"],
      ),
    ).toEqual(["test", "control"]);
  });

  it("releases the marker when PostHog rejects the event, so the next request retries", async () => {
    mocks.capturePostHog.mockResolvedValueOnce(false);
    const exposure = { teamId: "team-retry", variant: "test" } as const;

    trackRateLimitExperimentExposure(exposure);
    await settle();
    expect(mocks.markers.size).toBe(0);

    trackRateLimitExperimentExposure(exposure);
    await settle();
    expect(mocks.capturePostHog).toHaveBeenCalledTimes(2);
    expect(mocks.markers).toEqual(
      new Set(["firecrawl:rate_limit_exposure:team-retry:test"]),
    );
  });

  it("falls back to the team id as the person without an api key", async () => {
    trackRateLimitExperimentExposure({
      teamId: "team-no-key",
      variant: "test",
    });
    await settle();

    expect(mocks.capturePostHog).toHaveBeenCalledWith(
      "rate_limit_experiment_exposure",
      "team-no-key",
      expect.anything(),
    );
  });

  it("does nothing while capture is off, so no marker is spent", async () => {
    mocks.enabled.mockReturnValue(false);

    trackRateLimitExperimentExposure({ teamId: "team-off", variant: "test" });
    await settle();

    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.capturePostHog).not.toHaveBeenCalled();
  });
});
