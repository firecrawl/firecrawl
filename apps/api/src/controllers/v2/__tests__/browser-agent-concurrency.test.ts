import type { Response } from "express";
import { v4 as uuidv4 } from "uuid";

const SECRET = "agent-secret";

const mocks = vi.hoisted(() => ({
  teamConcurrency: 2,
  held: new Set<string>(),
  reserveExternalSlot: vi.fn(),
}));

vi.mock("../../../config", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../config")>();
  return {
    ...actual,
    config: {
      ...actual.config,
      HANGAR_URL: "http://hangar.test",
      AGENT_INTEROP_SECRET: "agent-secret",
    },
  };
});

vi.mock("../../../lib/logger", () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const child = vi.fn(() => ({ ...log, child }));
  return { logger: { ...log, child } };
});

vi.mock("../../../services/autumn/autumn.service", () => ({
  autumnService: {
    checkCredits: vi.fn(async () => null),
  },
}));

// Same admission rule as the real slot ledger: admit while under the limit.
vi.mock("../../../services/worker/nuq-router", () => ({
  reserveExternalSlot: mocks.reserveExternalSlot,
  mirrorExternalSlotRelease: vi.fn(async (_team: string, id: string) => {
    mocks.held.delete(id);
  }),
  getCombinedTeamActiveCount: vi.fn(async () => mocks.held.size),
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
  settleBrowserSessionOnce: vi.fn(),
  withLockedBrowserSession: vi.fn(),
  listUnsettledHangarSessions: vi.fn(),
  didBrowserSessionUsePrompt: vi.fn(),
  markBrowserSessionUsedPrompt: vi.fn(),
  upsertBrowserProfile: vi.fn(),
  deleteBrowserProfile: vi.fn(),
}));

vi.mock("../../../services/logging/log_job", () => ({
  logRequest: vi.fn(async () => {}),
}));

import { browserCreateController } from "../browser";
import { HOBBY_CONCURRENCY_LIMIT } from "../../../lib/concurrency-limit";
import { agentInteropStatus } from "../../../lib/agent-interop";

const TEAM_ID = "11111111-1111-1111-1111-111111111111";
const FREE_LIMIT = 2;

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

type Interop = keyof typeof INTEROP;

function makeReq(interop: Interop) {
  const [bodySecret, headerSecret] = INTEROP[interop];
  const body: Record<string, unknown> = {};
  const headers: Record<string, string> = {};
  if (bodySecret !== undefined) {
    body.__agentInterop = {
      auth: bodySecret,
      requestId: uuidv4(),
      shouldBill: false,
    };
  }
  if (headerSecret !== undefined)
    headers["x-firecrawl-agent-interop"] = headerSecret;
  return {
    body,
    headers,
    path: "/v2/browser",
    // As authMiddleware sets it, from the raw request.
    auth: {
      team_id: TEAM_ID,
      agentInterop: agentInteropStatus({ body, headers }),
    },
    acuc: {
      org_id: "org-1",
      api_key_id: null,
      flags: null,
      concurrency_limit: mocks.teamConcurrency,
      rate_limit_multiplier: 1,
    },
  };
}

/** Creates browsers until one is refused; returns how many were admitted. */
async function admittedUntilRefused(interop: Interop, max = 100) {
  for (let i = 0; i < max; i++) {
    const res = makeRes();
    await browserCreateController(makeReq(interop) as any, res as any);
    if (res.statusCode !== 200) {
      expect(res.statusCode).toBe(429);
      return { admitted: i, error: res.body.error as string };
    }
  }
  throw new Error("never refused");
}

describe("browser create concurrency for trusted agent requests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.held.clear();
    mocks.teamConcurrency = FREE_LIMIT;
    mocks.reserveExternalSlot.mockImplementation(
      async (_team: string, id: string, _ttl: number, limit: number) => {
        if (mocks.held.size >= limit) return false;
        mocks.held.add(id);
        return true;
      },
    );
  });

  it("lifts a free team's trusted agent (body secret) to the hobby limit", async () => {
    const { admitted, error } = await admittedUntilRefused("body");
    expect(admitted).toBe(HOBBY_CONCURRENCY_LIMIT);
    expect(error).toContain(`(${HOBBY_CONCURRENCY_LIMIT})`);
  });

  it("lifts a free team's trusted agent (header secret) to the hobby limit", async () => {
    const { admitted } = await admittedUntilRefused("header");
    expect(admitted).toBe(HOBBY_CONCURRENCY_LIMIT);
  });

  it("keeps the same free team at the free limit without interop", async () => {
    const { admitted, error } = await admittedUntilRefused("none");
    expect(admitted).toBe(FREE_LIMIT);
    expect(error).toContain(`(${FREE_LIMIT})`);
  });

  it("rejects a wrong header secret before any slot is reserved", async () => {
    const res = makeRes();
    await browserCreateController(makeReq("wrong-header") as any, res as any);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe("Invalid agent interop.");
    expect(mocks.reserveExternalSlot).not.toHaveBeenCalled();
  });

  it("rejects a wrong body secret before any slot is reserved", async () => {
    const res = makeRes();
    await browserCreateController(makeReq("wrong-body") as any, res as any);
    expect(res.statusCode).toBe(403);
    expect(mocks.reserveExternalSlot).not.toHaveBeenCalled();
  });

  it("counts slots already held by non-agent work toward the floor", async () => {
    mocks.held.add("scrape-1");
    mocks.held.add("scrape-2");
    const { admitted } = await admittedUntilRefused("body");
    expect(admitted).toBe(HOBBY_CONCURRENCY_LIMIT - 2);
  });

  it("leaves a plan above hobby unchanged for trusted agent requests", async () => {
    mocks.teamConcurrency = 50;
    const { admitted } = await admittedUntilRefused("body");
    expect(admitted).toBe(50);
  });

  it("keeps a team-specific Autumn grant above hobby as-is", async () => {
    mocks.teamConcurrency = HOBBY_CONCURRENCY_LIMIT + 3;
    expect((await admittedUntilRefused("body")).admitted).toBe(
      HOBBY_CONCURRENCY_LIMIT + 3,
    );
    mocks.held.clear();
    expect((await admittedUntilRefused("none")).admitted).toBe(
      HOBBY_CONCURRENCY_LIMIT + 3,
    );
  });

  it("passes the floored limit only to the browser reservation", async () => {
    await browserCreateController(makeReq("body") as any, makeRes() as any);
    await browserCreateController(makeReq("none") as any, makeRes() as any);
    const limits = mocks.reserveExternalSlot.mock.calls.map(c => c[3]);
    expect(limits).toEqual([HOBBY_CONCURRENCY_LIMIT, FREE_LIMIT]);
  });

  it.each(["valid-header-wrong-body", "wrong-header-valid-body"] as const)(
    "rejects %s with 403 before any slot is reserved",
    async interop => {
      const res = makeRes();
      await browserCreateController(makeReq(interop) as any, res as any);
      expect(res.statusCode).toBe(403);
      expect(res.body.error).toBe("Invalid agent interop.");
      expect(mocks.reserveExternalSlot).not.toHaveBeenCalled();
    },
  );

  it("floors a free team at hobby when both secrets are valid", async () => {
    expect((await admittedUntilRefused("both")).admitted).toBe(
      HOBBY_CONCURRENCY_LIMIT,
    );
  });
});
