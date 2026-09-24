import type { Response } from "express";
import type { RequestWithAuth } from "../types";

const mocks = vi.hoisted(() => ({
  getBrowserSession: vi.fn(),
  getBrowserSessionFromScrape: vi.fn(),
  claimBrowserSessionDestroyed: vi.fn(),
  mirrorExternalSlotRelease: vi.fn(),
  billTeam: vi.fn(),
  dbRows: [] as unknown[],
}));

// Only the real getBrowserSessionFromScrape reaches this: it selects every
// row for a scrape, newest first.
vi.mock("../../../db/connection", () => {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => Promise.resolve(mocks.dbRows),
  };
  return {
    db: { select: () => chain },
    dbRr: { select: () => chain },
    dbIndex: { select: () => chain },
    getDbPoolMetrics: () => "",
  };
});

vi.mock("../../../lib/logger", () => {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const child = vi.fn(() => ({ ...log, child }));
  return { logger: { ...log, child } };
});

vi.mock("../../../lib/browser-sessions", () => ({
  insertBrowserSession: vi.fn(),
  getBrowserSession: mocks.getBrowserSession,
  getBrowserSessionFromScrape: mocks.getBrowserSessionFromScrape,
  getBrowserSessionByBrowserId: vi.fn(),
  listBrowserSessions: vi.fn(),
  updateBrowserSessionActivity: vi.fn(),
  updateBrowserSessionStatus: vi.fn(),
  updateBrowserSessionCreditsUsed: vi.fn(),
  updateBrowserSessionScrapeId: vi.fn(),
  claimBrowserSessionDestroyed: mocks.claimBrowserSessionDestroyed,
  invalidateActiveBrowserSessionCount: vi.fn(() => Promise.resolve()),
  didBrowserSessionUsePrompt: vi.fn(),
  clearBrowserSessionPromptFlag: vi.fn(() => Promise.resolve()),
  markBrowserSessionUsedPrompt: vi.fn(),
  upsertBrowserProfile: vi.fn(),
  deleteBrowserProfile: vi.fn(),
  recordBrowserProfileDeleted: vi.fn(),
  getBrowserProfileDeletedAt: vi.fn(),
}));

vi.mock("../../../services/worker/nuq-router", () => ({
  getCombinedTeamActiveCount: vi.fn(),
  mirrorExternalSlotAcquire: vi.fn(),
  mirrorExternalSlotRelease: mocks.mirrorExternalSlotRelease,
}));

vi.mock("../../../services/billing/credit_billing", () => ({
  billTeam: mocks.billTeam,
}));

import { browserDeleteController } from "../browser";
import { scrapeStopInteractiveBrowserController } from "../scrape-browser";

const TEAM_ID = "11111111-1111-1111-1111-111111111111";
const SESSION_ID = "01a0d2f6-eea7-7520-ad2a-201d1aa3e9a0";

function makeSession(
  status: "active" | "destroyed",
  id = SESSION_ID,
  browserId = "b07ecb961ba4c547",
) {
  return {
    id,
    team_id: TEAM_ID,
    request_id: id,
    should_bill: true,
    browser_id: browserId,
    status,
    created_at: "2026-09-24T10:30:00.980Z",
    updated_at: "2026-09-24T10:30:40.075Z",
  };
}

function makeRes() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  } as unknown as Response & {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
  };
}

describe("browser session DELETE on an already destroyed session", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dbRows = [];
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("DELETE /v2/browser/:id returns 200 without calling the browser service", async () => {
    mocks.getBrowserSession.mockResolvedValue(makeSession("destroyed"));
    const req = {
      params: { sessionId: SESSION_ID },
      auth: { team_id: TEAM_ID },
    } as unknown as RequestWithAuth<{ sessionId: string }>;
    const res = makeRes();

    await browserDeleteController(req as any, res as any);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.claimBrowserSessionDestroyed).not.toHaveBeenCalled();
    expect(mocks.billTeam).not.toHaveBeenCalled();
  });

  it("DELETE /v2/scrape/:jobId/interact returns 200 without calling the browser service", async () => {
    mocks.getBrowserSessionFromScrape.mockResolvedValue(
      makeSession("destroyed"),
    );
    const req = {
      params: { jobId: "22222222-2222-2222-2222-222222222222" },
      auth: { team_id: TEAM_ID },
    } as unknown as RequestWithAuth<{ jobId: string }>;
    const res = makeRes();

    await scrapeStopInteractiveBrowserController(req as any, res as any);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.claimBrowserSessionDestroyed).not.toHaveBeenCalled();
    expect(mocks.billTeam).not.toHaveBeenCalled();
  });

  it("still returns 502 for an active session when the browser service fails", async () => {
    mocks.getBrowserSession.mockResolvedValue(makeSession("active"));
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("boom"),
    });
    const req = {
      params: { sessionId: SESSION_ID },
      auth: { team_id: TEAM_ID },
    } as unknown as RequestWithAuth<{ sessionId: string }>;
    const res = makeRes();

    await browserDeleteController(req as any, res as any);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "Browser session release was not confirmed.",
    });
    expect(mocks.claimBrowserSessionDestroyed).not.toHaveBeenCalled();
  });

  it("DELETE /v2/scrape/:jobId/interact releases the active row when the scrape also has a destroyed row", async () => {
    const actual = await vi.importActual<
      typeof import("../../../lib/browser-sessions")
    >("../../../lib/browser-sessions");
    mocks.getBrowserSessionFromScrape.mockImplementation(
      actual.getBrowserSessionFromScrape,
    );
    const activeId = "01a0d2f6-eea7-7520-ad2a-201d1aa3e9a1";
    mocks.dbRows = [
      makeSession("destroyed"),
      makeSession("active", activeId, "active-browser-id"),
    ];
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          ok: true,
          sessionDurationMs: 1000,
          cleanupQueued: true,
        }),
    });
    // Another path already billed the session, so the controller stops
    // after the release and does not bill.
    mocks.claimBrowserSessionDestroyed.mockResolvedValue(false);
    mocks.mirrorExternalSlotRelease.mockResolvedValue(undefined);
    const req = {
      params: { jobId: "22222222-2222-2222-2222-222222222222" },
      auth: { team_id: TEAM_ID },
    } as unknown as RequestWithAuth<{ jobId: string }>;
    const res = makeRes();

    await scrapeStopInteractiveBrowserController(req as any, res as any);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toMatch(
      /\/browsers\/active-browser-id$/,
    );
    expect(fetchMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(mocks.claimBrowserSessionDestroyed).toHaveBeenCalledWith(activeId);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, sessionDurationMs: 1000 }),
    );
  });
});
