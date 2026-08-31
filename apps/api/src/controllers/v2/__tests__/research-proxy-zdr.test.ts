import { vi } from "vitest";

const mocks = vi.hoisted(() => ({
  logRequest: vi.fn(),
  logResearchEndpoint: vi.fn(),
  fetchResearchUpstream: vi.fn(),
}));

vi.mock("../../../services/logging/log_job", () => ({
  logRequest: mocks.logRequest,
  logResearchEndpoint: mocks.logResearchEndpoint,
}));

vi.mock("../../../lib/research-upstream", () => ({
  fetchResearchUpstream: mocks.fetchResearchUpstream,
}));

vi.mock("../../../services/billing/credit_billing", () => ({
  billTeam: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../lib/keyless", () => ({
  chargeKeylessCredits: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

import { createDeveloperRouter, createResearchRouter } from "../research-proxy";

const TEAM_ID = "11111111-1111-1111-1111-111111111111";
const flush = () => new Promise(resolve => setImmediate(resolve));

function routeHandler(router: any, path: string) {
  const layer = router.stack.find(
    (candidate: any) =>
      candidate.route?.path === path && candidate.route?.methods?.get,
  );
  return layer.route.stack[0].handle;
}

function makeReq(
  query: Record<string, unknown>,
  flags: Record<string, unknown>,
) {
  return {
    method: "GET",
    query,
    params: {},
    body: {},
    headers: {},
    auth: { team_id: TEAM_ID },
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

async function callRoute(
  router: any,
  path: string,
  query: Record<string, unknown>,
  flags: Record<string, unknown>,
) {
  routeHandler(router, path)(makeReq(query, flags), makeRes(), vi.fn());
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.logRequest.mockResolvedValue(undefined);
  mocks.logResearchEndpoint.mockResolvedValue(undefined);
  mocks.fetchResearchUpstream.mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () =>
      JSON.stringify({
        success: true,
        results: [{ id: "private-result", content: "private payload" }],
      }),
  });
});

describe.each([
  {
    name: "research paper search",
    router: () => createResearchRouter(),
    path: "/papers",
    query: { query: "private research query" },
  },
  {
    name: "developer search",
    router: () => createDeveloperRouter(),
    path: "/search",
    query: { query: "private code query" },
  },
])("standalone ZDR persistence for $name", testCase => {
  it.each([
    { searchZDR: "forced-zdr" },
    { searchZDR: "forced-anon" },
    { forceZDR: true },
  ])("marks forced team payloads for redaction and cleanup", async flags => {
    await callRoute(testCase.router(), testCase.path, testCase.query, flags);

    expect(mocks.logRequest).toHaveBeenCalledWith(
      expect.objectContaining({ zeroDataRetention: true }),
    );
    expect(mocks.logResearchEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({ zeroDataRetention: true }),
    );
  });

  it("keeps normal retention for a team that may opt into ZDR", async () => {
    await callRoute(testCase.router(), testCase.path, testCase.query, {
      searchZDR: "allowed",
    });

    expect(mocks.logRequest).toHaveBeenCalledWith(
      expect.objectContaining({ zeroDataRetention: false }),
    );
    expect(mocks.logResearchEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({ zeroDataRetention: false }),
    );
  });
});
