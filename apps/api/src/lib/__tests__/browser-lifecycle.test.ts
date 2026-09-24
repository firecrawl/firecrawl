import { vi } from "vitest";
import { settleBrowserSession, stopBrowserSession } from "../browser-lifecycle";
import { stopHangarBrowser } from "../hangar";
import { billTeam } from "../../services/billing/credit_billing";
import { mirrorExternalSlotRelease } from "../../services/worker/nuq-router";
import {
  settleBrowserSessionOnce,
  type BrowserSessionRow,
} from "../browser-sessions";

vi.mock("../../config", () => ({ config: {} }));
vi.mock("../hangar", async importOriginal => ({
  ...(await importOriginal<typeof import("../hangar")>()),
  stopHangarBrowser: vi.fn(),
}));
vi.mock("../browser-sessions", () => ({
  insertBrowserSession: vi.fn(),
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
vi.mock("../concurrency-limit", () => ({
  getEffectiveConcurrencyLimit: vi.fn(),
}));
vi.mock("../../services/worker/nuq-router", () => ({
  getCombinedTeamActiveCount: vi.fn(),
  mirrorExternalSlotAcquire: vi.fn(),
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

it("does not bill or release a slot when Hangar only accepted the stop", async () => {
  vi.mocked(stopHangarBrowser).mockResolvedValue({
    ...stopped,
    status: "stopping",
    ended_at: null,
  });
  expect(await stopBrowserSession(session)).toEqual({
    success: true,
    status: "stopping",
    cleanupQueued: true,
  });
  expect(billTeam).not.toHaveBeenCalled();
  expect(settleBrowserSessionOnce).not.toHaveBeenCalled();
  expect(mirrorExternalSlotRelease).not.toHaveBeenCalled();
});

it("bills the upstream duration with the same idempotency key on retry", async () => {
  await settleBrowserSession(session, stopped);
  await settleBrowserSession(session, stopped);
  expect(billTeam).toHaveBeenNthCalledWith(1, "team", 2, null, {
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
