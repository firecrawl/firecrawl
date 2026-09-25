import { vi } from "vitest";
import { settleBrowserSession, stopBrowserSession } from "../browser-lifecycle";
import { stopHangarBrowser, getHangarBrowser } from "../hangar";
import { billTeam7 } from "../../db/rpc";
import { autumnService } from "../../services/autumn/autumn.service";
import { mirrorExternalSlotRelease } from "../../services/worker/nuq-router";
import {
  upsertBrowserProfile,
  settleBrowserSessionOnce,
  didBrowserSessionUsePrompt,
  type BrowserSessionRow,
} from "../browser-sessions";

const billingTransaction = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../config", () => ({
  config: {
    HANGAR_URL: "http://hangar",
    USE_DB_AUTHENTICATION: true,
    AUTUMN_SECRET_KEY: "test",
  },
}));
vi.mock("../hangar", async importOriginal => ({
  ...(await importOriginal<typeof import("../hangar")>()),
  createHangarBrowser: vi.fn(),
  stopHangarBrowser: vi.fn(),
  getHangarBrowser: vi.fn(),
}));
vi.mock("../browser-sessions", () => ({
  insertBrowserSession: vi.fn(),
  activateBrowserSession: vi.fn(),
  completeBrowserSessionSettlement: vi.fn(async () => {}),
  upsertBrowserProfile: vi.fn(async () => {}),
  getBrowserProfileDeletedAt: vi.fn(async () => null),
  settleBrowserSessionOnce: vi.fn(
    async (
      _id: string,
      bill: (
        row: BrowserSessionRow,
        tx: typeof billingTransaction,
      ) => Promise<number>,
    ) => ({
      creditsBilled: await bill(currentSession, billingTransaction),
      newlySettled: true,
    }),
  ),
  updateBrowserSessionCreditsUsed: vi.fn(async () => {}),
  invalidateActiveBrowserSessionCount: vi.fn(async () => {}),
  didBrowserSessionUsePrompt: vi.fn(async () => false),
  clearBrowserSessionPromptFlag: vi.fn(),
  listUnsettledHangarSessions: vi.fn(),
}));
vi.mock("../../controllers/auth", () => ({
  getACUCTeam: vi.fn(async () => ({ org_id: "org" })),
}));
vi.mock("../../services/rate-limiter", () => ({
  redisRateLimitClient: {},
}));
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
  autumnService: {
    checkCredits: vi.fn(),
    trackCredits: vi.fn(async () => true),
  },
}));
vi.mock("../../db/rpc", () => ({
  billTeam7: vi.fn(async () => []),
}));
vi.mock("../../services/logging/log_job", () => ({ logRequest: vi.fn() }));
vi.mock("../keyless", () => ({
  updateKeylessBrowserCredits: vi.fn(async () => true),
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
  created_at: new Date().toISOString(),
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
  expect(autumnService.trackCredits).not.toHaveBeenCalled();
  expect(settleBrowserSessionOnce).not.toHaveBeenCalled();
  expect(mirrorExternalSlotRelease).not.toHaveBeenCalled();
});

it("bills the upstream duration with the same idempotency key on retry", async () => {
  await settleBrowserSession(session, stopped);
  currentSession = { ...session, scrape_id: "scrape" };
  await settleBrowserSession(session, stopped);
  expect(autumnService.trackCredits).toHaveBeenNthCalledWith(
    1,
    {
      teamId: "team",
      orgId: "org",
      value: 2,
      properties: {
        source: "billTeam",
        endpoint: "browser",
        jobId: "session",
        apiKeyId: null,
      },
      idempotencyKey: "fc:track:browser-session:session:destroy",
    },
    { idempotent: true },
  );
  expect(vi.mocked(autumnService.trackCredits).mock.calls[1][0]).toMatchObject({
    properties: { endpoint: "interact" },
    idempotencyKey: "fc:track:browser-session:session:destroy",
  });
  expect(billTeam7).toHaveBeenCalledWith(
    {
      team_id: "team",
      subscription_id: null,
      credits: 2,
      api_key_id: null,
      is_extract: false,
    },
    billingTransaction,
  );
});

it("keeps settlement retryable when billing fails", async () => {
  vi.mocked(autumnService.trackCredits).mockResolvedValueOnce(false);
  await expect(settleBrowserSession(session, stopped)).rejects.toThrow(
    "Browser billing was not confirmed.",
  );
  expect(billTeam7).not.toHaveBeenCalled();
  expect(mirrorExternalSlotRelease).not.toHaveBeenCalled();
});

it("rejects missing durations instead of guessing a bill", async () => {
  await expect(
    settleBrowserSession(session, { ...stopped, ended_at: null }),
  ).rejects.toMatchObject({ status: 502 });
  expect(autumnService.trackCredits).not.toHaveBeenCalled();
});

it("preserves the agent billing exemption", async () => {
  currentSession = { ...session, should_bill: false };
  expect(
    await settleBrowserSession({ ...session, should_bill: false }, stopped),
  ).toEqual({ sessionDurationMs: 60_000, creditsBilled: 0 });
  expect(didBrowserSessionUsePrompt).not.toHaveBeenCalled();
  expect(autumnService.trackCredits).not.toHaveBeenCalled();
  expect(billTeam7).not.toHaveBeenCalled();
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

vi.mock("../../services/redlock", () => ({ redlock: { using: vi.fn() } }));
