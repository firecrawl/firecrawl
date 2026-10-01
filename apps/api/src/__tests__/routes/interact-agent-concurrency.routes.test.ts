import express from "express";
import request from "supertest";

// The real authMiddleware, auth.ts and scrapeInteractController (which
// re-parses req.body and drops `__agentInterop`); only I/O is mocked.
const mocks = vi.hoisted(() => ({
  authChunk: vi.fn(),
  reserveExternalSlot: vi.fn(),
}));

vi.mock("../../config", async importOriginal => {
  const actual = await importOriginal<typeof import("../../config")>();
  return {
    ...actual,
    config: {
      ...actual.config,
      USE_DB_AUTHENTICATION: true,
      HANGAR_URL: "http://hangar.test",
      AGENT_INTEROP_SECRET: "agent-secret",
    },
  };
});
vi.mock("../../db/connection", () => ({ db: {}, dbRr: {}, dbIndex: {} }));
vi.mock("../../db/rpc", () => ({
  authCreditUsageChunk: mocks.authChunk,
  authCreditUsageChunkFromTeam: vi.fn(),
  getAgentFreeRequestsLeft: vi.fn(),
}));
vi.mock("../../services/redis", () => ({
  getValue: vi.fn().mockResolvedValue(null),
  setValue: vi.fn(),
  deleteKey: vi.fn(),
}));
vi.mock("../../services/redlock", () => ({
  redlock: { using: vi.fn(async (_k, _t, _o, fn) => fn({ aborted: false })) },
}));
vi.mock("ioredis", () => ({ default: class {} }));
vi.mock("../../services/rate-limiter", async importOriginal => ({
  ...(await importOriginal<typeof import("../../services/rate-limiter")>()),
  getRateLimiter: vi.fn(() => ({ consume: vi.fn() })),
  getAutumnRateLimiter: vi.fn(() => ({ consume: vi.fn() })),
  redisRateLimitClient: {
    set: vi.fn().mockResolvedValue("OK"),
    get: vi.fn().mockResolvedValue(null),
    del: vi.fn().mockResolvedValue(1),
    eval: vi.fn().mockResolvedValue(1),
  },
}));
vi.mock("../../services/autumn/autumn.service", async importOriginal => {
  const actual =
    await importOriginal<
      typeof import("../../services/autumn/autumn.service")
    >();
  return {
    ...actual,
    autumnService: {
      getRateLimitMultiplier: vi.fn().mockResolvedValue(1),
      getKnownRateLimitMultiplier: vi.fn().mockResolvedValue(1),
      // Free plan: Autumn grants CONCURRENCY 2.
      getConcurrencyLimit: vi.fn().mockResolvedValue(2),
      checkCredits: vi.fn().mockResolvedValue(null),
    },
  };
});
vi.mock("../../services/agent-sponsor", () => ({
  getAgentSponsorStatus: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../services/queue-service", () => ({
  getRedisConnection: vi.fn(() => ({ sadd: vi.fn() })),
  getBillingQueue: vi.fn(() => ({ add: vi.fn() })),
}));
vi.mock("../../services/logging/log_job", () => ({
  logRequest: vi.fn(),
  logProviderScrape: vi.fn(),
}));
vi.mock("../../services/worker/nuq-router", () => ({
  scrapeQueue: { getJob: vi.fn(async () => null) },
  getCombinedTeamActiveCount: vi.fn(async () => 0),
  reserveExternalSlot: mocks.reserveExternalSlot,
  mirrorExternalSlotRelease: vi.fn(async () => {}),
}));
vi.mock("../../lib/operational-job-access", () => ({
  getScrapeJobAccess: vi.fn(async () => ({
    teamId: "team-free",
    expiresAtMs: Date.now() + 60_000,
  })),
}));
vi.mock("../../lib/job-state-store", () => ({
  readScrapeJobState: vi.fn(async () => null),
}));
vi.mock("../../lib/job-store-fallback", () => ({
  recordJobStorePostgresFallback: vi.fn(),
}));
vi.mock("../../lib/supabase-jobs", () => ({
  supabaseGetScrapeByIdDirect: vi.fn(async () => ({
    id: "scrape-1",
    team_id: "team-free",
    url: "https://example.com",
    options: {},
  })),
}));
vi.mock("../../lib/browser-sessions", () => ({
  insertBrowserSession: vi.fn(async (row: unknown) => row),
  completeBrowserSessionSettlement: vi.fn(async () => {}),
  getBrowserSession: vi.fn(async () => null),
  getBrowserSessionFromScrape: vi.fn(async () => null),
  listUnsettledHangarSessions: vi.fn(async () => []),
  updateBrowserSessionActivity: vi.fn(async () => {}),
  updateBrowserSessionScrapeId: vi.fn(async () => {}),
  settleBrowserSessionOnce: vi.fn(),
  markBrowserSessionUsedPrompt: vi.fn(async () => {}),
  didBrowserSessionUsePrompt: vi.fn(),
  upsertBrowserProfile: vi.fn(),
}));
vi.mock("../../lib/hangar", async importOriginal => ({
  ...(await importOriginal<typeof import("../../lib/hangar")>()),
  createHangarBrowser: vi.fn(async () => ({
    id: "br_1",
    cdp_url: "wss://cdp.test",
    view_url: null,
    control_url: null,
    playlist_url: null,
    max_expires_at: null,
  })),
  executeHangarBrowser: vi.fn(async () => ({
    stdout: "",
    result: "",
    stderr: "",
    exitCode: 0,
    killed: false,
  })),
  stopHangarBrowser: vi.fn(async () => {}),
}));
vi.mock("../../lib/scrape-interact/browser-agent", () => ({
  selectBrowserAgentTab: vi.fn(async () => {}),
  executePromptViaBrowserAgent: vi.fn(),
  executeCodeViaBrowserSession: vi.fn(async () => ({
    stdout: "",
    result: "",
    stderr: "",
    exitCode: 0,
    killed: false,
  })),
}));
vi.mock("../../lib/browser-session-activity", () => ({
  enqueueBrowserSessionActivity: vi.fn(),
}));
vi.mock("../../services/billing/credit_billing", () => ({
  billTeam: vi.fn(async () => {}),
}));

import { authMiddleware } from "../../routes/shared";
import { RateLimiterMode } from "../../types";
import { scrapeInteractController } from "../../controllers/v2/scrape-browser";
import { HOBBY_CONCURRENCY_LIMIT } from "../../lib/concurrency-limit";
import { getBrowserSessionFromScrape } from "../../lib/browser-sessions";
import { executeCodeViaBrowserSession } from "../../lib/scrape-interact/browser-agent";

const API_KEY = "33333333-3333-4333-8333-333333333333";
const SECRET = "agent-secret";
const FREE_LIMIT = 2;

const app = express();
app.use(express.json());
app.post(
  "/v2/scrape/:jobId/interact",
  authMiddleware(RateLimiterMode.BrowserExecute),
  (req, res, next) => {
    scrapeInteractController(req as any, res as any).catch(next);
  },
);

const WRONG = "not-the-secret";

// [body secret, header secret] for each case; undefined means not sent.
const INTEROP = {
  none: [undefined, undefined],
  body: [SECRET, undefined],
  header: [undefined, SECRET],
  both: [SECRET, SECRET],
  "wrong-body": [WRONG, undefined],
  "wrong-header": [undefined, WRONG],
  "valid-header-wrong-body": [WRONG, SECRET],
  "wrong-header-valid-body": [SECRET, WRONG],
} as const;

type Interop = keyof typeof INTEROP | "forged";

function interact(interop: Interop) {
  const [bodySecret, headerSecret] =
    interop === "forged" ? [undefined, undefined] : INTEROP[interop];
  let body: Record<string, unknown> = { code: "console.log(1)" };
  if (bodySecret !== undefined) {
    body.__agentInterop = {
      auth: bodySecret,
      requestId: "11111111-1111-4111-8111-111111111111",
      shouldBill: true,
    };
  }
  if (interop === "forged") {
    body = {
      ...body,
      trustedAgentInterop: true,
      auth: { team_id: "team-free", trustedAgentInterop: true },
    };
  }
  let req = request(app)
    .post("/v2/scrape/scrape-1/interact")
    .set("authorization", `Bearer ${API_KEY}`);
  if (headerSecret !== undefined)
    req = req.set("x-firecrawl-agent-interop", headerSecret);
  return req.send(body);
}

/** The limit the interact path passed to the browser slot reservation. */
async function reservedLimit(interop: Interop): Promise<number> {
  await interact(interop);
  expect(mocks.reserveExternalSlot).toHaveBeenCalledTimes(1);
  return mocks.reserveExternalSlot.mock.calls[0][3];
}

describe("interact browser concurrency for trusted agent requests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reserveExternalSlot.mockResolvedValue(true);
    vi.mocked(getBrowserSessionFromScrape).mockResolvedValue(null);
    mocks.authChunk.mockResolvedValue([
      {
        api_key: API_KEY,
        api_key_id: 9,
        api_key_id_text: "9",
        team_id: "team-free",
        org_id: "org-free",
        is_banned: false,
        flags: null,
        credential_purpose: "general",
      },
    ]);
  });

  it("floors a free team at hobby when the secret is only in the body", async () => {
    expect(await reservedLimit("body")).toBe(HOBBY_CONCURRENCY_LIMIT);
  });

  it("floors a free team at hobby when the secret is only in the header", async () => {
    expect(await reservedLimit("header")).toBe(HOBBY_CONCURRENCY_LIMIT);
  });

  it("floors a free team at hobby when both secrets are valid", async () => {
    expect(await reservedLimit("both")).toBe(HOBBY_CONCURRENCY_LIMIT);
  });

  it.each([
    "wrong-body",
    "wrong-header",
    "valid-header-wrong-body",
    "wrong-header-valid-body",
  ] as const)("rejects %s with the same 403 as /v2/browser", async interop => {
    const res = await interact(interop);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      success: false,
      error: "Invalid agent interop.",
    });
    expect(mocks.reserveExternalSlot).not.toHaveBeenCalled();
  });

  it("serves a request without interop at the free limit", async () => {
    expect(await reservedLimit("none")).toBe(FREE_LIMIT);
  });

  it("ignores a forged trustedAgentInterop field in the body", async () => {
    expect(await reservedLimit("forged")).toBe(FREE_LIMIT);
  });
});

describe("interact on an existing browser session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authChunk.mockResolvedValue([
      {
        api_key: API_KEY,
        api_key_id: 9,
        api_key_id_text: "9",
        team_id: "team-free",
        org_id: "org-free",
        is_banned: false,
        flags: null,
        credential_purpose: "general",
      },
    ]);
    vi.mocked(getBrowserSessionFromScrape).mockResolvedValue({
      id: "session-1",
      team_id: "team-free",
      browser_id: "br_1",
      status: "active",
      cdp_url: "wss://cdp.test",
      cdp_path: "",
      cdp_interactive_path: "",
    } as any);
  });

  it.each([
    "wrong-body",
    "wrong-header",
    "valid-header-wrong-body",
    "wrong-header-valid-body",
  ] as const)("rejects %s with 403 and executes nothing", async interop => {
    const res = await interact(interop);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      success: false,
      error: "Invalid agent interop.",
    });
    expect(executeCodeViaBrowserSession).not.toHaveBeenCalled();
  });

  it.each(["body", "header", "both", "none"] as const)(
    "executes on the reused session with %s interop",
    async interop => {
      const res = await interact(interop);
      expect(res.status).toBe(200);
      expect(executeCodeViaBrowserSession).toHaveBeenCalledTimes(1);
      expect(mocks.reserveExternalSlot).not.toHaveBeenCalled();
    },
  );
});
