import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  /** Redis keys the SET NX / DEL mocks hold, so a test sees the marker lifecycle. */
  markers: new Set<string>(),
  set: vi.fn(),
  del: vi.fn(),
  capturePostHog: vi.fn(),
  enabled: vi.fn(),
}));

vi.mock("../../services/rate-limiter", () => ({
  redisRateLimitClient: { set: mocks.set, del: mocks.del },
}));
vi.mock("../../services/posthog-capture", () => ({
  capturePostHog: mocks.capturePostHog,
  isPostHogCaptureEnabled: mocks.enabled,
}));

import {
  KEYLESS_PROMPT_SHOWN_EVENT,
  keylessPromptDedupeKey,
  trackKeylessPromptShown,
} from "../keyless-prompt-analytics";

const TEAM_UUID = "abd15a03-d147-557e-801b-005da8c69bbf";
const PROMPT = {
  keylessTeamId: TEAM_UUID,
  surface: "mcp" as const,
  reason: "limit" as const,
  httpStatus: 429,
  tokenLink: true,
};

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
  vi.useFakeTimers({
    now: new Date("2026-10-01T23:59:30.000Z"),
    toFake: ["Date"],
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("keylessPromptDedupeKey", () => {
  it("keys on the UTC day, team, surface and reason", () => {
    expect(keylessPromptDedupeKey(PROMPT)).toBe(
      `keyless_prompt_shown:2026-10-01:${TEAM_UUID}:mcp:limit`,
    );
    expect(
      keylessPromptDedupeKey(PROMPT, new Date("2026-10-02T00:00:01.000Z")),
    ).toBe(`keyless_prompt_shown:2026-10-02:${TEAM_UUID}:mcp:limit`);
    expect(
      keylessPromptDedupeKey({ ...PROMPT, reason: "suspicious_ip" }),
    ).not.toBe(keylessPromptDedupeKey(PROMPT));
    expect(keylessPromptDedupeKey({ ...PROMPT, surface: "cli" })).not.toBe(
      keylessPromptDedupeKey(PROMPT),
    );
  });
});

describe("trackKeylessPromptShown", () => {
  it("claims the day's marker with SET NX and a 25h TTL, then captures", async () => {
    trackKeylessPromptShown(PROMPT);
    await settle();

    expect(mocks.set).toHaveBeenCalledExactlyOnceWith(
      `keyless_prompt_shown:2026-10-01:${TEAM_UUID}:mcp:limit`,
      "1",
      "EX",
      90000,
      "NX",
    );
    expect(mocks.capturePostHog).toHaveBeenCalledExactlyOnceWith(
      KEYLESS_PROMPT_SHOWN_EVENT,
      TEAM_UUID,
      {
        keyless_team_id: TEAM_UUID,
        surface: "mcp",
        reason: "limit",
        http_status: 429,
        link_type: "token",
        $process_person_profile: false,
      },
    );
  });

  it("keeps the marker once PostHog accepts the event", async () => {
    trackKeylessPromptShown(PROMPT);
    await settle();

    expect(mocks.del).not.toHaveBeenCalled();
    expect(mocks.markers.has(keylessPromptDedupeKey(PROMPT))).toBe(true);
  });

  it("releases the marker when PostHog rejects the event, so the next prompt retries", async () => {
    mocks.capturePostHog.mockResolvedValueOnce(false);

    trackKeylessPromptShown(PROMPT);
    await settle();

    expect(mocks.del).toHaveBeenCalledExactlyOnceWith(
      `keyless_prompt_shown:2026-10-01:${TEAM_UUID}:mcp:limit`,
    );
    expect(mocks.markers.size).toBe(0);

    // The retry captures only because the release cleared the SET NX marker.
    trackKeylessPromptShown(PROMPT);
    await settle();
    expect(mocks.capturePostHog).toHaveBeenCalledTimes(2);
    expect(mocks.markers.has(keylessPromptDedupeKey(PROMPT))).toBe(true);
  });

  it("swallows a failed marker release", async () => {
    mocks.capturePostHog.mockResolvedValueOnce(false);
    mocks.del.mockRejectedValueOnce(new Error("redis down"));

    expect(() => trackKeylessPromptShown(PROMPT)).not.toThrow();
    await settle();

    expect(mocks.del).toHaveBeenCalledTimes(1);
  });

  it("labels a prompt without a token as the fallback link", async () => {
    trackKeylessPromptShown({
      ...PROMPT,
      reason: "unsupported_endpoint",
      httpStatus: 401,
      tokenLink: false,
    });
    await settle();

    expect(mocks.capturePostHog).toHaveBeenCalledWith(
      KEYLESS_PROMPT_SHOWN_EVENT,
      TEAM_UUID,
      expect.objectContaining({
        reason: "unsupported_endpoint",
        http_status: 401,
        link_type: "fallback",
      }),
    );
  });

  it("does not capture again once the day's marker exists", async () => {
    trackKeylessPromptShown(PROMPT);
    trackKeylessPromptShown(PROMPT);
    await settle();

    expect(mocks.set).toHaveBeenCalledTimes(2);
    await expect(mocks.set.mock.results[1].value).resolves.toBeNull();
    expect(mocks.capturePostHog).toHaveBeenCalledTimes(1);
  });

  it("spends no marker while capture is off", async () => {
    mocks.enabled.mockReturnValue(false);

    trackKeylessPromptShown(PROMPT);
    await settle();

    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.capturePostHog).not.toHaveBeenCalled();
  });

  it("returns before Redis answers and swallows a Redis failure", async () => {
    let fail!: (error: Error) => void;
    mocks.set.mockReturnValueOnce(
      new Promise((_, reject) => {
        fail = reject;
      }),
    );

    expect(trackKeylessPromptShown(PROMPT)).toBeUndefined();
    expect(mocks.capturePostHog).not.toHaveBeenCalled();
    fail(new Error("redis down"));
    await settle();

    expect(mocks.capturePostHog).not.toHaveBeenCalled();
  });
});
