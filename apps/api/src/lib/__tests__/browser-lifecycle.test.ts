import { vi } from "vitest";
import { settleBrowserSession, stopBrowserSession } from "../browser-lifecycle";
import { stopHangarBrowser, getHangarBrowser } from "../hangar";
import { billTeam } from "../../services/billing/credit_billing";
import { mirrorExternalSlotRelease } from "../../services/worker/nuq-router";
import {
  upsertBrowserProfile,
  settleBrowserSessionOnce,
  type BrowserSessionRow,
} from "../browser-sessions";

vi.mock("../../config", () => ({ config: { HANGAR_URL: "http://hangar" } }));
vi.mock("../hangar", async importOriginal => ({
  ...(await importOriginal<typeof import("../hangar")>()),
  createHangarBrowser: vi.fn(),
  stopHangarBrowser: vi.fn(),
  getHangarBrowser: vi.fn(),
}));
vi.mock("../browser-sessions", () => ({
  insertBrowserSession: vi.fn(),
  upsertBrowserProfile: vi.fn(async () => {}),
  getBrowserProfileDeletedAt: vi.fn(async () => null),
  settleBrowserSessionOnce: vi.fn(
    async (_id: string, bill: (row: BrowserSessionRow) => Promise<number>) => ({
      creditsBilled: await bill(currentSession),
      newlySettled: true,
    }),
  ),
  updateBrowserSessionCreditsUsed: vi.fn(async () => {}),
  invalidateActiveBrowserSessionCount: vi.fn(async () => {}),
  didBrowserSessionUsePrompt: vi.fn(async () => false),
  clearBrowserSessionPromptFlag: vi.fn(),
  listUnsettledHangarSessions: vi.fn(),
}));
vi.mock("../team-org", () => ({ orgIdForTeam: vi.fn(async () => "org") }));
vi.mock("../request-credits-store", () => ({
  recordRequestCredits: vi.fn(async () => {}),
}));
vi.mock("../concurrency-limit", () => ({
  getEffectiveConcurrencyLimit: vi.fn(),
}));
vi.mock("../../services/worker/nuq-router", () => ({
  getCombinedTeamActiveCount: vi.fn(),
  reserveExternalSlot: vi.fn(async () => true),
  mirrorExternalSlotRelease: vi.fn(async () => {}),
}));
vi.mock("../../services/autumn/autumn.service", () => ({
  autumnService: { checkCredits: vi.fn() },
}));
vi.mock("../../services/billing/credit_billing", () => ({
  billTeam: vi.fn(async () => ({ success: true })),
}));
vi.mock("../../services/logging/log_job", () => ({ logRequest: vi.fn() }));
vi.mock("../keyless", () => ({
  reserveKeylessCredits: vi.fn(),
  adjustKeylessCredits: vi.fn(async () => {}),
  logKeylessCreditUsage: vi.fn(async () => {}),
  KEYLESS_FREE_TIER_LIMIT_MESSAGE: "limit",
}));
vi.mock("../logger", () => ({ logger: { error: vi.fn() } }));

const session = {
  id: "session",
  browser_id: "br_test",
  team_id: "team",
  status: "active",
  should_bill: true,
  ttl_total: 600,
  request_id: "session",
} as BrowserSessionRow;
const stopped = {
  id: "br_test",
  status: "stopped" as const,
  created_at: 100,
  ended_at: 160,
  recording: true,
  max_expires_at: 700,
};
let currentSession = session;
beforeEach(() => {
  vi.clearAllMocks();
  currentSession = session;
});

it("waits for final duration before returning the existing delete response", async () => {
  vi.mocked(stopHangarBrowser).mockResolvedValue({
    ...stopped,
    status: "stopping",
    ended_at: null,
  });
  vi.mocked(getHangarBrowser).mockResolvedValue(stopped);
  expect(await stopBrowserSession(session)).toEqual({
    success: true,
    status: "stopped",
    cleanupQueued: true,
    sessionDurationMs: 60_000,
    creditsBilled: 2,
  });
  expect(getHangarBrowser).toHaveBeenCalledWith("br_test", 0, 5000);
});

it("does not return a successful partial response or bill when cleanup never finishes", async () => {
  vi.useFakeTimers();
  try {
    const stopping = {
      ...stopped,
      status: "stopping" as const,
      ended_at: null,
    };
    vi.mocked(stopHangarBrowser).mockResolvedValue(stopping);
    vi.mocked(getHangarBrowser).mockResolvedValue(stopping);
    const result = expect(stopBrowserSession(session)).rejects.toMatchObject({
      status: 502,
    });
    await vi.runAllTimersAsync();
    await result;
  } finally {
    vi.useRealTimers();
  }
  expect(billTeam).not.toHaveBeenCalled();
  expect(settleBrowserSessionOnce).not.toHaveBeenCalled();
  expect(mirrorExternalSlotRelease).not.toHaveBeenCalled();
});

it("bills the upstream duration with the same idempotency key on retry", async () => {
  await settleBrowserSession(session, stopped);
  await settleBrowserSession(session, stopped);
  expect(billTeam).toHaveBeenNthCalledWith(1, "team", "org", 2, null, {
    endpoint: "browser",
    jobId: "session",
    chargeId: "session:destroy",
  });
  expect(vi.mocked(billTeam).mock.calls[1]).toEqual(
    vi.mocked(billTeam).mock.calls[0],
  );
});

it("keeps settlement retryable when billing fails", async () => {
  vi.mocked(billTeam).mockRejectedValueOnce(new Error("billing unavailable"));
  await expect(settleBrowserSession(session, stopped)).rejects.toThrow(
    "billing unavailable",
  );
  expect(mirrorExternalSlotRelease).not.toHaveBeenCalled();
});

it("rejects missing durations instead of guessing a bill", async () => {
  await expect(
    settleBrowserSession(session, { ...stopped, ended_at: null }),
  ).rejects.toMatchObject({ status: 502 });
  expect(billTeam).not.toHaveBeenCalled();
});

it("preserves the agent billing exemption", async () => {
  currentSession = { ...session, should_bill: false };
  expect(
    await settleBrowserSession({ ...session, should_bill: false }, stopped),
  ).toEqual({ sessionDurationMs: 60_000, creditsBilled: 0 });
  expect(billTeam).not.toHaveBeenCalled();
  expect(mirrorExternalSlotRelease).toHaveBeenCalledWith("team", "session");
});

it("registers a profile only after Hangar confirms a save", async () => {
  const owner = "00000000-0000-4000-8000-000000000001";
  await settleBrowserSession(
    { ...session, team_id: owner, profile_name: "login" },
    { ...stopped, profile_saved_at: 160 },
  );
  expect(upsertBrowserProfile).toHaveBeenCalledWith({
    teamId: owner,
    name: "login",
    savedAt: new Date(160_000).toISOString(),
    sizeBytes: undefined,
  });
});
it("does not register a failed or discarded profile save", async () => {
  await settleBrowserSession(
    {
      ...session,
      team_id: "00000000-0000-4000-8000-000000000001",
      profile_name: "login",
    },
    stopped,
  );
  expect(upsertBrowserProfile).not.toHaveBeenCalled();
});
it("does not call Hangar again for an already destroyed session", async () => {
  expect(
    await stopBrowserSession({
      ...session,
      status: "destroyed",
      credits_used: 2,
    }),
  ).toMatchObject({ success: true, creditsBilled: 2 });
  expect(stopHangarBrowser).not.toHaveBeenCalled();
});
