import { vi } from "vitest";

const mocks = vi.hoisted(() => ({
  logRequest: vi.fn(),
  logSearch: vi.fn(),
  logResearchEndpoint: vi.fn(),
  fetchResearchUpstream: vi.fn(),
  chargeKeylessCredits: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../services/logging/log_job", () => ({
  logRequest: mocks.logRequest,
  logSearch: mocks.logSearch,
  logResearchEndpoint: mocks.logResearchEndpoint,
}));

vi.mock("../../../lib/research-upstream", () => ({
  fetchResearchUpstream: mocks.fetchResearchUpstream,
}));

vi.mock("../../../services/billing/credit_billing", () => ({
  billTeam: vi.fn().mockResolvedValue(undefined),
}));

// Real `keylessTeamId` is kept so the test can build a production-shaped
// `preview_keyless_<ip>` team id (see ../../../lib/keyless.ts:44-46). Only
// `chargeKeylessCredits` — the function research-proxy.ts calls to actually
// charge a keyless caller's per-IP credit budget — is mocked, so this test
// stays a unit test of research-proxy.ts's wiring rather than exercising real
// Redis.
vi.mock("../../../lib/keyless", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../lib/keyless")>();
  return { ...actual, chargeKeylessCredits: mocks.chargeKeylessCredits };
});

vi.mock("../../../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

import { createDeveloperRouter } from "../research-proxy";
import { config } from "../../../config";
import { billTeam } from "../../../services/billing/credit_billing";
import { chargeKeylessCredits, keylessTeamId } from "../../../lib/keyless";

const TEAM_ID = "11111111-1111-1111-1111-111111111111";
// RFC 5737 TEST-NET-3 address: a valid IPv4 that's guaranteed non-routable,
// used only as a stand-in client IP for building a keyless team id.
const KEYLESS_IP = "203.0.113.7";
const KEYLESS_TEAM_ID = keylessTeamId(KEYLESS_IP);
const ORIGINAL_HMAC_SECRET = config.KEYLESS_CONVERSION_HMAC_SECRET;

/** Lets the un-awaited controller (wrapped by `wrap`) and its `finally` run. */
const flush = () => new Promise(resolve => setImmediate(resolve));

/** Pulls the GET handler out of the router's stack for either mount shape. */
function developerHandler(options: { root?: boolean } = {}) {
  const router: any = createDeveloperRouter(options);
  const path = options.root ? "/" : "/search";
  const layer = router.stack.find(
    (l: any) => l.route?.path === path && l.route?.methods?.get,
  );
  return layer.route.stack[0].handle;
}

function makeReq(teamId: string, acuc: Record<string, unknown> | undefined) {
  return {
    method: "GET",
    query: { query: "http client" },
    body: {},
    headers: {},
    auth: { team_id: teamId },
    acuc,
  } as any;
}

function makeAuthedReq(flags: Record<string, unknown>) {
  return makeReq(TEAM_ID, { api_key_id: 7, flags });
}

/**
 * A real keyless request: team id shaped like `chargeKeylessCredits`/
 * `billTeam` (via autumn's `isPreviewTeam`) key their behavior on — see
 * ../../../lib/keyless.ts:39-46 — and an `acuc` matching the object
 * production keyless callers actually get, `mockPreviewACUC(team_id, false)`
 * in ../../auth.ts:81-90 (assigned at ../../auth.ts:543), not "no acuc at
 * all".
 */
function makeKeylessReq() {
  return makeReq(KEYLESS_TEAM_ID, {
    api_key: "preview",
    api_key_id: 0,
    team_id: KEYLESS_TEAM_ID,
    org_id: "preview",
    flags: null,
    is_banned: false,
    is_extract: false,
  });
}

function makeRes() {
  const res: any = {
    status: vi.fn(),
    json: vi.fn(),
    send: vi.fn(),
    end: vi.fn(),
    setHeader: vi.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  res.send.mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  config.KEYLESS_CONVERSION_HMAC_SECRET = "a".repeat(32);
  mocks.logRequest.mockResolvedValue(undefined);
  mocks.logResearchEndpoint.mockResolvedValue(undefined);
  // The controller consumes this as a `fetch` Response: `.ok`, `.status`,
  // `.headers.get()` and `await .text()`. A plain body object makes
  // `.headers.get()` throw and the handler answer 502 from its catch block,
  // which would let these tests pass without ever serving a real response.
  // At least one result is required for the request to bill any credits.
  mocks.fetchResearchUpstream.mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () =>
      JSON.stringify({ success: true, results: [{ id: "repo-one" }] }),
  });
});

afterAll(() => {
  config.KEYLESS_CONVERSION_HMAC_SECRET = ORIGINAL_HMAC_SECRET;
});

describe.each([
  { name: "/v2/search/developer", options: { root: true } },
  { name: "/v2/developer/search (compatibility mount)", options: {} },
])("developer endpoint access on $name", ({ options }) => {
  it("serves a team with no flags at all", async () => {
    const res = makeRes();
    await developerHandler(options)(makeAuthedReq({}), res);
    await flush();

    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(mocks.fetchResearchUpstream).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
    // Ordinary team billing runs for the real (non-keyless) team id.
    expect(billTeam).toHaveBeenCalledWith(
      TEAM_ID,
      expect.any(Number),
      expect.anything(),
      expect.anything(),
    );
  });

  it("serves a keyless caller (preview_keyless_<ip> team id)", async () => {
    const res = makeRes();
    await developerHandler(options)(makeKeylessReq(), res);
    await flush();

    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(mocks.fetchResearchUpstream).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({
          "firecrawl-team-id":
            "preview_keyless_hmac_v1_3031c7208ae268b72293b554",
        }),
      }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
    // Keyless credit charging runs for the keyless-shaped team id — this is
    // the assertion that regresses if the developer endpoint's keyless
    // billing path breaks (see research-proxy.ts:317-335).
    expect(chargeKeylessCredits).toHaveBeenCalledWith(
      KEYLESS_TEAM_ID,
      expect.any(Number),
    );
  });
});
