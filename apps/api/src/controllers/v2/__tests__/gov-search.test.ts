import { vi } from "vitest";

const mocks = vi.hoisted(() => ({
  logRequest: vi.fn(),
  logResearchEndpoint: vi.fn(),
  fetchGovUpstream: vi.fn(),
  chargeKeylessCredits: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../services/logging/log_job", () => ({
  logRequest: mocks.logRequest,
  logResearchEndpoint: mocks.logResearchEndpoint,
}));

vi.mock("../../../lib/research-upstream", () => ({
  fetchResearchUpstream: vi.fn(),
  fetchGovUpstream: mocks.fetchGovUpstream,
}));

vi.mock("../../../services/billing/credit_billing", () => ({
  billTeam: vi.fn().mockResolvedValue(undefined),
}));

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

import { createGovRouter } from "../research-proxy";
import { billTeam } from "../../../services/billing/credit_billing";
import { keylessTeamId } from "../../../lib/keyless";

const TEAM_ID = "11111111-1111-1111-1111-111111111111";
const KEYLESS_TEAM_ID = keylessTeamId("203.0.113.7");

const flush = () => new Promise(resolve => setImmediate(resolve));

function handler(method: "get" | "post") {
  const router: any = createGovRouter();
  const layer = router.stack.find(
    (l: any) => l.route?.path === "/" && l.route?.methods?.[method],
  );
  return layer.route.stack[0].handle;
}

function makeReq(
  method: "GET" | "POST",
  input: Record<string, unknown>,
  teamId: string = TEAM_ID,
  flags: Record<string, unknown> | null = {},
) {
  return {
    method,
    query: method === "GET" ? input : {},
    body: method === "POST" ? input : {},
    headers: {},
    auth: { team_id: teamId },
    acuc: { api_key_id: 7, flags },
  } as any;
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

function upstreamWith(web: unknown[]) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () => JSON.stringify({ success: true, data: { web } }),
  };
}

const WEB_RESULT = {
  url: "https://www.ecfr.gov/current/title-21/part-101",
  title: "21 CFR Part 101",
  description: "Food labeling",
  position: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.logRequest.mockResolvedValue(undefined);
  mocks.logResearchEndpoint.mockResolvedValue(undefined);
  mocks.fetchGovUpstream.mockResolvedValue(upstreamWith([WEB_RESULT]));
});

describe("/v2/search/gov", () => {
  it.each(["GET", "POST"] as const)(
    "serves a %s request for free",
    async method => {
      const res = makeRes();
      await handler(method === "GET" ? "get" : "post")(
        makeReq(method, { query: "food labeling rules", k: "5" }),
        res,
      );
      await flush();

      expect(mocks.fetchGovUpstream).toHaveBeenCalledWith(
        expect.objectContaining({ query: "food labeling rules", k: 5 }),
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: { web: [WEB_RESULT] },
      });
      expect(billTeam).not.toHaveBeenCalled();
      expect(mocks.logResearchEndpoint).toHaveBeenCalledWith(
        expect.objectContaining({
          table: "gov_searches",
          num_results: 1,
          credits_cost: 0,
          is_successful: true,
        }),
      );
    },
  );

  it("stays free under zero data retention and marks the logs", async () => {
    const res = makeRes();
    await handler("get")(
      makeReq("GET", { query: "food labeling rules" }, TEAM_ID, {
        searchZDR: "forced-zdr",
      }),
      res,
    );
    await flush();

    expect(billTeam).not.toHaveBeenCalled();
    expect(mocks.logResearchEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({ credits_cost: 0, zeroDataRetention: true }),
    );
  });

  it("passes an upstream error through without billing", async () => {
    mocks.fetchGovUpstream.mockResolvedValue({
      ok: false,
      status: 500,
      headers: new Headers(),
      text: async () =>
        JSON.stringify({ success: false, error: "index unavailable" }),
    });
    const res = makeRes();
    await handler("get")(makeReq("GET", { query: "zoning variance" }), res);
    await flush();

    expect(res.status).toHaveBeenCalledWith(500);
    expect(billTeam).not.toHaveBeenCalled();
    expect(mocks.logResearchEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        is_successful: false,
        credits_cost: 0,
        error: "index unavailable",
      }),
    );
  });

  it.each([
    ["GET", { query: "" }],
    ["GET", { query: "rules", k: "101" }],
    ["GET", { query: "rules", magic: "true" }],
    ["POST", { query: "rules", magic: "true" }],
  ] as const)(
    "rejects invalid %s input %j before the upstream call",
    async (method, input) => {
      const res = makeRes();
      await handler(method === "GET" ? "get" : "post")(
        makeReq(method, input),
        res,
      );
      await flush();

      expect(res.status).toHaveBeenCalledWith(400);
      expect(mocks.fetchGovUpstream).not.toHaveBeenCalled();
    },
  );

  it("maps an upstream timeout to 504", async () => {
    mocks.fetchGovUpstream.mockRejectedValue(
      new DOMException("timed out", "TimeoutError"),
    );
    const res = makeRes();
    await handler("get")(makeReq("GET", { query: "zoning variance" }), res);
    await flush();

    expect(res.status).toHaveBeenCalledWith(504);
  });

  it("serves a keyless caller and records zero keyless credits", async () => {
    const res = makeRes();
    await handler("get")(
      makeReq("GET", { query: "zoning variance" }, KEYLESS_TEAM_ID, null),
      res,
    );
    await flush();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mocks.chargeKeylessCredits).toHaveBeenCalledWith(KEYLESS_TEAM_ID, 0);
  });
});
