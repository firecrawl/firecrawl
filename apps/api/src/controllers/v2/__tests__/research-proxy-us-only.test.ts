import { vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchResearchUpstream: vi.fn(),
}));

vi.mock("../../../services/logging/log_job", () => ({
  logRequest: vi.fn().mockResolvedValue(undefined),
  logResearchEndpoint: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../lib/research-upstream", async importOriginal => ({
  ...(await importOriginal<typeof import("../../../lib/research-upstream")>()),
  fetchResearchUpstream: mocks.fetchResearchUpstream,
}));

vi.mock("../../../services/billing/credit_billing", () => ({
  billTeam: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../lib/keyless", () => ({
  chargeKeylessCredits: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../lib/index-daily-limit", () => ({
  reserveIndexCalls: vi.fn(async () => ({ ok: true, release: async () => {} })),
  indexDailyLimitRefusal: vi.fn(),
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

const REFUSAL =
  "Paper search is not available for teams restricted to US-only processing.";
const flush = () => new Promise(resolve => setImmediate(resolve));

function upstream(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

async function callRoute(
  router: any,
  path: string,
  query: Record<string, unknown>,
  flags: Record<string, unknown>,
) {
  const layer = router.stack.find(
    (candidate: any) =>
      candidate.route?.path === path && candidate.route?.methods?.get,
  );
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
  layer.route.stack.at(-1).handle(
    {
      method: "GET",
      query,
      params: {},
      body: {},
      headers: {},
      auth: { team_id: "11111111-1111-1111-1111-111111111111" },
      acuc: { api_key_id: 7, flags },
    },
    res,
    vi.fn(),
  );
  await flush();
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each([
  {
    name: "research paper search",
    router: () => createResearchRouter(),
    path: "/papers",
    query: { query: "retrieval augmented generation" },
  },
  {
    name: "developer search",
    router: () => createDeveloperRouter(),
    path: "/search",
    query: { query: "retry with backoff" },
  },
])("US-only processing on $name", testCase => {
  it("asks for US-only processing and relays a refusal as the US-only error", async () => {
    mocks.fetchResearchUpstream.mockResolvedValue(
      upstream(403, { success: false, code: "FORBIDDEN", error: REFUSAL }),
    );

    const res = await callRoute(
      testCase.router(),
      testCase.path,
      testCase.query,
      { usOnly: true },
    );

    expect(mocks.fetchResearchUpstream).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({ "firecrawl-us-only": "true" }),
      }),
    );
    expect(res.setHeader).toHaveBeenLastCalledWith(
      "content-type",
      "application/json",
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      code: "US_ONLY_UNAVAILABLE",
      error: REFUSAL,
    });
  });

  it("passes other upstream errors through unchanged", async () => {
    const body = { success: false, code: "NOT_FOUND", error: "No match." };
    mocks.fetchResearchUpstream.mockResolvedValue(upstream(404, body));

    const res = await callRoute(
      testCase.router(),
      testCase.path,
      testCase.query,
      { usOnly: true },
    );

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(body);
  });

  it("leaves a team without the restriction unchanged", async () => {
    const body = { success: false, code: "FORBIDDEN", error: "Forbidden." };
    mocks.fetchResearchUpstream.mockResolvedValue(upstream(403, body));

    const res = await callRoute(
      testCase.router(),
      testCase.path,
      testCase.query,
      {},
    );

    expect(
      mocks.fetchResearchUpstream.mock.calls[0][0].headers,
    ).not.toHaveProperty("firecrawl-us-only");
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(body);
  });
});
