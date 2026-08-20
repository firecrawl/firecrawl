import { vi } from "vitest";

const mocks = vi.hoisted(() => ({
  logRequest: vi.fn(),
  logResearchEndpoint: vi.fn(),
  fetchResearchUpstream: vi.fn(),
  chargeKeylessCredits: vi.fn(),
}));

vi.mock("../../../services/logging/log_job", () => ({
  logRequest: mocks.logRequest,
  logResearchEndpoint: mocks.logResearchEndpoint,
}));

vi.mock("../../../lib/research-upstream", () => ({
  fetchResearchUpstream: mocks.fetchResearchUpstream,
}));

vi.mock("../../../services/billing/credit_billing", () => ({
  billTeam: vi.fn(),
}));

vi.mock("../../../lib/keyless", () => ({
  chargeKeylessCredits: mocks.chargeKeylessCredits,
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

function makeReq(query: Record<string, unknown>, params = {}) {
  return {
    method: "GET",
    query,
    params,
    body: {},
    headers: {},
    auth: { team_id: TEAM_ID },
    acuc: { api_key_id: 7, flags: {} },
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
  params = {},
) {
  const res = makeRes();
  routeHandler(router, path)(makeReq(query, params), res, vi.fn());
  await flush();
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.logRequest.mockResolvedValue(undefined);
  mocks.logResearchEndpoint.mockResolvedValue(undefined);
  mocks.chargeKeylessCredits.mockResolvedValue(undefined);
  mocks.fetchResearchUpstream.mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () => JSON.stringify({ success: true, results: [] }),
  });
});

describe("research upstream timeouts", () => {
  it.each([
    {
      name: "paper search",
      router: () => createResearchRouter(),
      path: "/papers",
      query: { query: "graph databases" },
      params: {},
      timeoutMs: 30_000,
    },
    {
      name: "similar papers",
      router: () => createResearchRouter(),
      path: "/papers/:id/similar",
      query: { intent: "related work" },
      params: { id: "paper-1" },
      timeoutMs: 10_000,
    },
    {
      name: "GitHub search",
      router: () => createResearchRouter(),
      path: "/github",
      query: { query: "retry logic" },
      params: {},
      timeoutMs: 12_000,
    },
    {
      name: "developer search",
      router: () => createDeveloperRouter(),
      path: "/search",
      query: { query: "http client" },
      params: {},
      timeoutMs: 15_000,
    },
  ])("applies the $name timeout", async testCase => {
    await callRoute(
      testCase.router(),
      testCase.path,
      testCase.query,
      testCase.params,
    );

    expect(mocks.fetchResearchUpstream).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: testCase.timeoutMs }),
    );
  });

  it.each([
    { name: "inspect", query: {}, timeoutMs: 5_000 },
    { name: "read", query: { query: "summarize methods" }, timeoutMs: 120_000 },
  ])("uses the paper $name timeout", async ({ query, timeoutMs }) => {
    await callRoute(createResearchRouter(), "/papers/:id", query, {
      id: "paper-1",
    });

    expect(mocks.fetchResearchUpstream).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs }),
    );
  });

  it.each([
    {
      name: "request",
      error: new DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError",
      ),
    },
    {
      name: "connect",
      error: new TypeError("fetch failed", {
        cause: Object.assign(new Error("Connect Timeout Error"), {
          name: "ConnectTimeoutError",
        }),
      }),
    },
  ])("maps a $name timeout to 504", async ({ error }) => {
    mocks.fetchResearchUpstream.mockRejectedValue(error);

    const res = await callRoute(createResearchRouter(), "/github", {
      query: "retry logic",
    });

    expect(mocks.fetchResearchUpstream).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 12_000 }),
    );
    expect(res.status).toHaveBeenCalledWith(504);
    expect(res.end).toHaveBeenCalled();
  });
});
