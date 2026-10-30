import type { Response } from "express";

const mocks = vi.hoisted(() => ({
  checkCredits: vi.fn(),
  markHostedMcp: vi.fn(),
  cameFromHostedMcp: vi.fn(),
  usedPrompt: vi.fn(),
  settleOnce: vi.fn(),
  billTeam: vi.fn(),
  recordRequestCredits: vi.fn(),
  getHangarBrowser: vi.fn(),
}));

vi.mock("../../../config", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../config")>();
  return {
    ...actual,
    config: { ...actual.config, HANGAR_URL: "http://hangar.test" },
  };
});

vi.mock("../../../lib/logger", () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const child = vi.fn(() => ({ ...log, child }));
  return { logger: { ...log, child } };
});

vi.mock("../../../services/autumn/autumn.service", () => ({
  autumnService: {
    checkCredits: mocks.checkCredits,
    hostedMcpFeatureId: async () => "MCP_CREDITS",
  },
  CREDITS_FEATURE_ID: "CREDITS",
  DEFAULT_TEAM_LIMITS: { concurrency_limit: 2 },
}));

vi.mock("../../../services/worker/nuq-router", () => ({
  reserveExternalSlot: vi.fn(async () => true),
  mirrorExternalSlotRelease: vi.fn(async () => {}),
  getCombinedTeamActiveCount: vi.fn(async () => 0),
}));

vi.mock("../../../lib/hangar", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../lib/hangar")>();
  return {
    ...actual,
    createHangarBrowser: vi.fn(async (key: string) => ({
      id: `browser-${key}`,
      cdp_url: "wss://cdp.test",
      view_url: null,
      control_url: null,
      playlist_url: null,
      max_expires_at: null,
    })),
    getHangarBrowser: mocks.getHangarBrowser,
    stopHangarBrowser: vi.fn(async () => {}),
  };
});

vi.mock("../../../lib/browser-sessions", () => ({
  insertBrowserSession: vi.fn(async (row: { id: string }) => ({
    ...row,
    cdp_url: "wss://cdp.test",
    cdp_path: "",
    cdp_interactive_path: "",
  })),
  completeBrowserSessionSettlement: vi.fn(),
  getBrowserSession: vi.fn(),
  getBrowserSessionFromScrape: vi.fn(),
  listBrowserSessions: vi.fn(),
  updateBrowserSessionActivity: vi.fn(),
  updateBrowserSessionScrapeId: vi.fn(),
  settleBrowserSessionOnce: mocks.settleOnce,
  withLockedBrowserSession: vi.fn(async (_id: string, run: any) =>
    run({
      id: "session-1",
      status: "active",
      credits_used: null,
      should_bill: true,
    }),
  ),
  listUnsettledHangarSessions: vi.fn(),
  didBrowserSessionUsePrompt: mocks.usedPrompt,
  markBrowserSessionUsedPrompt: vi.fn(),
  markBrowserSessionHostedMcp: mocks.markHostedMcp,
  didBrowserSessionComeFromHostedMcp: mocks.cameFromHostedMcp,
  upsertBrowserProfile: vi.fn(),
  deleteBrowserProfile: vi.fn(),
}));

vi.mock("../../../services/billing/credit_billing", () => ({
  billTeam: mocks.billTeam,
}));
vi.mock("../../../lib/team-org", () => ({
  orgIdForTeam: vi.fn(async () => "org-1"),
}));
vi.mock("../../../lib/request-credits-store", () => ({
  recordRequestCredits: mocks.recordRequestCredits,
}));
vi.mock("../../../lib/keyless", () => ({
  updateKeylessBrowserCredits: vi.fn(async () => true),
  logKeylessCreditUsage: vi.fn(async () => {}),
  KEYLESS_FREE_TIER_LIMIT_MESSAGE: "limit",
}));
vi.mock("../../../services/logging/log_job", () => ({
  logRequest: vi.fn(async () => {}),
}));

import { browserCreateController } from "../browser";
import {
  reserveBrowserPromptCredits,
  settleBrowserSession,
} from "../../../lib/browser-lifecycle";

const TEAM_ID = "11111111-1111-1111-1111-111111111111";

function makeRes() {
  return {
    statusCode: 200,
    body: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
}

function makeReq(hostedMcp: boolean) {
  return {
    body: { ttl: 600 },
    headers: {},
    path: "/v2/browser",
    auth: {
      team_id: TEAM_ID,
      agentInterop: "none",
      ...(hostedMcp ? { hostedMcp: true } : {}),
    },
    acuc: {
      org_id: "org-1",
      api_key_id: null,
      flags: null,
      concurrency_limit: 10,
      rate_limit_multiplier: 1,
    },
  };
}

async function create(hostedMcp: boolean) {
  const res = makeRes();
  await browserCreateController(
    makeReq(hostedMcp) as any,
    res as unknown as Response,
  );
  return res;
}

const session = {
  id: "session-1",
  team_id: TEAM_ID,
  browser_id: "browser-1",
  request_id: "session-1",
  scrape_id: null,
  status: "active",
  credits_used: null,
  should_bill: true,
  ttl_total: 600,
  zero_data_retention: false,
  profile_name: null,
} as any;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.checkCredits.mockResolvedValue({ allowed: true, remaining: 1000 });
  mocks.markHostedMcp.mockResolvedValue(undefined);
  mocks.cameFromHostedMcp.mockResolvedValue(false);
  mocks.usedPrompt.mockResolvedValue(false);
  mocks.billTeam.mockResolvedValue({ success: true });
  mocks.recordRequestCredits.mockResolvedValue(true);
  mocks.getHangarBrowser.mockResolvedValue({ status: "running" });
});

describe("browser sessions from hosted MCP calls", () => {
  it("checks MCP credits for a hosted session and marks it hosted", async () => {
    const res = await create(true);
    expect(res.statusCode).toBe(200);
    expect(mocks.checkCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: TEAM_ID,
        orgId: "org-1",
        value: 20,
        featureId: "MCP_CREDITS",
      }),
    );
    expect(mocks.markHostedMcp).toHaveBeenCalledWith(res.body.id);
  });

  it("refuses a hosted session the MCP credits check refuses", async () => {
    mocks.checkCredits.mockResolvedValue({ allowed: false, remaining: 5 });

    expect((await create(true)).statusCode).toBe(402);
    expect(mocks.markHostedMcp).not.toHaveBeenCalled();
  });

  it("leaves a session not from the hosted MCP as it was", async () => {
    mocks.checkCredits.mockResolvedValue({ allowed: false, remaining: 5 });
    expect((await create(false)).statusCode).toBe(402);

    mocks.checkCredits.mockResolvedValue({ allowed: true, remaining: 1000 });
    expect((await create(false)).statusCode).toBe(200);
    for (const [check] of mocks.checkCredits.mock.calls) {
      expect(check.featureId).toBeUndefined();
    }
    expect(mocks.markHostedMcp).not.toHaveBeenCalled();
  });

  it("still creates the session when the hosted flag cannot be stored", async () => {
    mocks.markHostedMcp.mockRejectedValue(new Error("redis down"));
    expect((await create(true)).statusCode).toBe(200);
  });

  it("checks MCP credits for a hosted prompt", async () => {
    await reserveBrowserPromptCredits(makeReq(true) as any, session);
    expect(mocks.checkCredits).toHaveBeenLastCalledWith(
      expect.objectContaining({ value: 70, featureId: "MCP_CREDITS" }),
    );

    mocks.checkCredits.mockResolvedValue({ allowed: false, remaining: 0 });
    await expect(
      reserveBrowserPromptCredits(makeReq(true) as any, session),
    ).rejects.toMatchObject({ status: 402 });
  });

  it("marks the session hosted on a hosted prompt the balance covers", async () => {
    await reserveBrowserPromptCredits(makeReq(true) as any, session);
    expect(mocks.markHostedMcp).toHaveBeenCalledWith("session-1");

    mocks.markHostedMcp.mockClear();
    await reserveBrowserPromptCredits(makeReq(false) as any, session);
    expect(mocks.markHostedMcp).not.toHaveBeenCalled();
  });

  it.each([
    [true, { hostedMcp: true }],
    [false, {}],
  ])(
    "settles a session (hosted: %s) with the hosted MCP signal it was created with",
    async (hosted, extra) => {
      mocks.cameFromHostedMcp.mockResolvedValue(hosted);
      mocks.settleOnce.mockResolvedValue({
        creditsBilled: 10,
        newlySettled: true,
      });
      await settleBrowserSession(session, {
        status: "stopped",
        created_at: 1000,
        ended_at: 1300,
      } as any);
      expect(mocks.billTeam).toHaveBeenCalledWith(TEAM_ID, "org-1", 10, null, {
        endpoint: "browser",
        jobId: "session-1",
        chargeId: "session-1:destroy",
        ...extra,
      });
    },
  );
});
