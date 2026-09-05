import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  insert: vi.fn(),
  mark: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
  invalidate: vi.fn(),
  refund: vi.fn(),
  service: vi.fn(),
  get: vi.fn(),
  claim: vi.fn(),
  clear: vi.fn(),
  bill: vi.fn(),
  credits: vi.fn(),
}));
vi.mock("uuid", () => ({ v7: () => "session" }));
vi.mock("../../../config", () => ({
  config: {
    BROWSER_SERVICE_URL: "http://browser.test",
    USE_DB_AUTHENTICATION: true,
  },
}));
vi.mock("../../../lib/logger", () => ({
  logger: {
    child() {
      return this;
    },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock("../../../lib/browser-sessions", () => ({
  insertBrowserSession: mock.insert,
  markBrowserSessionCreationFailed: mock.mark,
  getBrowserSession: mock.get,
  getBrowserSessionByBrowserId: mock.get,
  listBrowserSessions: vi.fn(),
  updateBrowserSessionActivity: vi.fn(),
  updateBrowserSessionStatus: vi.fn(),
  updateBrowserSessionCreditsUsed: mock.credits,
  claimBrowserSessionDestroyed: mock.claim,
  invalidateActiveBrowserSessionCount: mock.invalidate,
  didBrowserSessionUsePrompt: async () => true,
  clearBrowserSessionPromptFlag: mock.clear,
  getBrowserSessionFromScrape: mock.get,
  updateBrowserSessionScrapeId: vi.fn(),
  markBrowserSessionUsedPrompt: vi.fn(),
}));
vi.mock("../../../services/worker/nuq-router", () => ({
  getCombinedTeamActiveCount: async () => 0,
  mirrorExternalSlotAcquire: mock.acquire,
  mirrorExternalSlotRelease: mock.release,
}));
vi.mock("../../../lib/concurrency-limit", () => ({
  getEffectiveConcurrencyLimit: async () => 10,
}));
vi.mock("../../../services/billing/credit_billing", () => ({
  billTeam: mock.bill,
}));
vi.mock("../../../lib/browser-session-activity", () => ({
  enqueueBrowserSessionActivity: vi.fn(),
}));
vi.mock("../../../services/logging/log_job", () => ({ logRequest: vi.fn() }));
vi.mock("../../../services/autumn/autumn.service", () => ({
  autumnService: { checkCredits: async () => null },
}));
vi.mock("../../../lib/agent-interop", () => ({
  isAgentInteropSecretValid: () => false,
}));
vi.mock("../../../lib/keyless", () => ({
  reserveKeylessCredits: async () => ({ ok: true }),
  adjustKeylessCredits: mock.refund,
  keylessTeamUuid: () => null,
  logKeylessCreditUsage: async () => {},
}));
vi.mock("../../../lib/supabase-jobs", () => ({
  supabaseGetScrapeById: async () => ({ team_id: "team", options: {} }),
}));
vi.mock("../../../lib/scrape-interact/browser-service-client", () => ({
  browserServiceRequest: mock.service,
  BrowserServiceError: class extends Error {},
}));
vi.mock("../../../lib/scrape-interact/scrape-replay", () => ({
  buildReplayContextFromScrape: () => ({
    context: { targetUrl: "https://example.com", actions: [] },
  }),
  estimateReplayTimeoutSeconds: () => 1,
  buildReplayScript: () => "script",
}));
vi.mock("../../../lib/scrape-interact/browser-agent", () => ({
  executePromptViaBrowserAgent: vi.fn(),
  executeCodeViaBrowserSession: vi.fn(),
}));
vi.mock("../../../lib/scrape-interact/langsmith", () => ({
  sanitizeUrlForTrace: (url: string) => url,
}));
vi.mock("../../../lib/zdr-helpers", () => ({ getScrapeZDR: () => false }));
import { browserCreateController, browserDeleteController } from "../browser";
import { scrapeInteractController } from "../scrape-browser";
const req = () =>
  ({
    auth: { team_id: "team" },
    acuc: { api_key_id: 1 },
    body: { ttl: 600, code: "code", language: "node" },
    params: { jobId: "scrape", sessionId: "session" },
    headers: {},
    path: "/browser",
  }) as any;
const res = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() }) as any;
beforeEach(() => {
  vi.resetAllMocks();
  mock.bill.mockResolvedValue({ success: true });
  mock.service.mockImplementation(async (_method, path) =>
    path === "/browsers"
      ? { sessionId: "provider", cdpUrl: "ws://browser" }
      : {
          exitCode: 0,
          stdout: "https://example.com",
          ok: true,
          cleanupQueued: true,
          sessionDurationMs: 1000,
        },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, opts) => ({
      ok: true,
      status: 200,
      json: async () =>
        opts.method === "POST"
          ? { sessionId: "provider" }
          : { ok: true, cleanupQueued: true, sessionDurationMs: 1000 },
    })),
  );
  mock.insert.mockResolvedValue({
    id: "session",
    team_id: "team",
    status: "active",
  });
});
afterEach(() => vi.unstubAllGlobals());
for (const [label, create] of [
  ["browser", browserCreateController],
  ["scrape browser", scrapeInteractController],
] as const) {
  it(`${label} rolls back row and external slot after acquire fails`, async () => {
    const error = new Error("Redis acquire failed");
    mock.acquire.mockRejectedValue(error);
    await expect(create(req(), res())).rejects.toBe(error);
    expect(mock.mark).toHaveBeenCalledWith("session");
    expect(mock.release).toHaveBeenCalledWith("team", "session");
    expect(mock.invalidate).toHaveBeenCalledTimes(2);
    if (label === "browser")
      expect(fetch).toHaveBeenCalledWith(
        "http://browser.test/browsers/provider",
        expect.objectContaining({ method: "DELETE" }),
      );
    else
      expect(mock.service).toHaveBeenCalledWith("DELETE", "/browsers/provider");
  });
  it(`${label} rolls back when count invalidation fails before slot acquisition`, async () => {
    const error = new Error("Redis invalidate failed");
    mock.invalidate.mockRejectedValueOnce(error).mockResolvedValue(undefined);
    await expect(create(req(), res())).rejects.toBe(error);
    expect(mock.mark).toHaveBeenCalledWith("session");
    expect(mock.acquire).not.toHaveBeenCalled();
    expect(mock.release).toHaveBeenCalledWith("team", "session");
    expect(mock.invalidate).toHaveBeenCalledTimes(2);
  });
  it(`${label} preserves original and cleanup errors while attempting every cleanup`, async () => {
    const error = new Error("Redis acquire failed"),
      cleanup = new Error("DB rollback failed");
    mock.acquire.mockRejectedValue(error);
    mock.mark.mockRejectedValue(cleanup);
    await expect(create(req(), res())).rejects.toMatchObject({
      errors: [error, cleanup],
    });
    expect(mock.release).toHaveBeenCalled();
    expect(mock.invalidate).toHaveBeenCalledTimes(2);
  });
}
it("teardown attempts slot release even when invalidation fails", async () => {
  mock.get.mockResolvedValue({
    id: "session",
    team_id: "team",
    browser_id: "provider",
  });
  const error = new Error("invalidate failed");
  mock.invalidate.mockRejectedValue(error);
  await expect(browserDeleteController(req(), res())).rejects.toBe(error);
  expect(mock.release).toHaveBeenCalledWith("team", "session");
  expect(mock.claim).not.toHaveBeenCalled();
});
it("retries prompt cleanup for already completed billing", async () => {
  mock.get.mockResolvedValue({
    id: "session",
    team_id: "team",
    browser_id: "provider",
    credits_used: 2,
  });
  mock.claim.mockResolvedValue(false);
  await browserDeleteController(req(), res());
  expect(mock.clear).toHaveBeenCalledWith("session");
  expect(mock.bill).not.toHaveBeenCalled();
});
it("retains prompt billing state if billing did not complete", async () => {
  mock.get.mockResolvedValue({
    id: "session",
    team_id: "team",
    browser_id: "provider",
    credits_used: null,
  });
  mock.claim.mockResolvedValue(false);
  await browserDeleteController(req(), res());
  expect(mock.clear).not.toHaveBeenCalled();
});
it("persists billing completion only after charging and before clearing the prompt flag", async () => {
  mock.get.mockResolvedValue({
    id: "session",
    team_id: "team",
    browser_id: "provider",
    credits_used: null,
    should_bill: true,
  });
  mock.claim.mockResolvedValue(true);
  await browserDeleteController(req(), res());
  expect(mock.bill.mock.invocationCallOrder[0]).toBeLessThan(
    mock.credits.mock.invocationCallOrder[0],
  );
  expect(mock.credits.mock.invocationCallOrder[0]).toBeLessThan(
    mock.clear.mock.invocationCallOrder[0],
  );
});
it("does not mark billing complete or clear prompt rate after billing fails", async () => {
  mock.get.mockResolvedValue({
    id: "session",
    team_id: "team",
    browser_id: "provider",
    credits_used: null,
    should_bill: true,
  });
  mock.claim.mockResolvedValue(true);
  const error = new Error("billing failed");
  mock.bill.mockRejectedValue(error);
  await expect(browserDeleteController(req(), res())).rejects.toBe(error);
  expect(mock.credits).not.toHaveBeenCalled();
  expect(mock.clear).not.toHaveBeenCalled();
});

it("propagates an unsuccessful billing result without recording completion", async () => {
  const original = new Error("Redis billing queue failed");
  mock.get.mockImplementation(async id =>
    id === "session"
      ? {
          id,
          team_id: "team",
          browser_id: "provider",
          credits_used: null,
          should_bill: true,
        }
      : null,
  );
  mock.claim.mockResolvedValue(true);
  mock.bill.mockResolvedValue({ success: false, error: original });
  await expect(browserDeleteController(req(), res())).rejects.toBe(original);
  expect(mock.get).toHaveBeenCalledWith("session");
  expect(mock.credits).not.toHaveBeenCalled();
  expect(mock.clear).not.toHaveBeenCalled();
});
