import { vi } from "vitest";

const mockLogRequest = vi.fn();
const mockLogSearch = vi.fn();
const mockLogResearchEndpoint = vi.fn();

vi.mock("../../../services/logging/log_job", () => ({
  logRequest: (...args: any[]) => mockLogRequest(...args),
  logSearch: (...args: any[]) => mockLogSearch(...args),
  logResearchEndpoint: (...args: any[]) => mockLogResearchEndpoint(...args),
}));

const mockExecuteSearch = vi.fn();

vi.mock("../../../search/execute", () => ({
  executeSearch: (...args: any[]) => mockExecuteSearch(...args),
}));

vi.mock("../../../services/billing/credit_billing", () => ({
  billTeam: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../lib/keyless", () => ({
  KEYLESS_FREE_TIER_LIMIT_MESSAGE: "keyless limit reached",
  adjustKeylessCredits: vi.fn().mockResolvedValue(undefined),
  logKeylessCreditUsage: vi.fn().mockResolvedValue(undefined),
  reserveKeylessCredits: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("../../../lib/keyless-credit-projection", () => ({
  projectSearchTotalCredits: () => 0,
}));

vi.mock("../../../lib/threat-protection/request", () => ({
  resolveThreatProtection: vi.fn().mockResolvedValue({ policy: null }),
  checkUrlsAgainstThreatPolicy: vi.fn(),
}));

vi.mock("../../../lib/key-restriction", () => ({
  actionTypesOf: () => [],
  formatTypesOf: () => [],
  checkKeyFormatRestriction: vi.fn().mockResolvedValue({ allowed: true }),
  checkKeyEndpointRestriction: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("../../../services/sentry", () => ({
  applyZdrScope: vi.fn(),
  captureExceptionWithZdrCheck: vi.fn(),
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

import { searchController } from "../search";

const TEAM_ID = "11111111-1111-1111-1111-111111111111";

const developerResults = [
  {
    url: "https://github.com/example/repo",
    title: "example/repo",
    description: "a repo",
    position: 1,
    category: "developer",
  },
  {
    url: "https://github.com/example/other",
    title: "example/other",
    description: "another repo",
    position: 2,
    category: "developer",
  },
];

function executeResult(overrides: Record<string, any> = {}) {
  return {
    response: { web: [], developer: developerResults },
    totalResultsCount: 2,
    searchCredits: 2,
    scrapeCredits: 0,
    totalCredits: 2,
    shouldScrape: false,
    ...overrides,
  };
}

function makeReq(body: Record<string, any>, headers: Record<string, any> = {}) {
  return {
    body,
    headers,
    auth: { team_id: TEAM_ID },
    acuc: { api_key_id: 7, flags: null },
  } as any;
}

function makeRes() {
  const res: any = {
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

async function flushAsync() {
  await new Promise(resolve => setImmediate(resolve));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLogRequest.mockResolvedValue(undefined);
  mockLogSearch.mockResolvedValue(undefined);
  mockLogResearchEndpoint.mockResolvedValue(undefined);
  mockExecuteSearch.mockResolvedValue(executeResult());
});

describe("developer category code_searches ledger", () => {
  it("writes exactly one code_searches row for a developer category search", async () => {
    const req = makeReq({
      query: "vector database client",
      categories: ["developer"],
      origin: "sdk",
      integration: "cli",
    });
    const res = makeRes();

    await searchController(req, res);
    await flushAsync();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockLogResearchEndpoint).toHaveBeenCalledTimes(1);
    const row = mockLogResearchEndpoint.mock.calls[0][0];
    expect(row.table).toBe("code_searches");
    expect(row.team_id).toBe(TEAM_ID);
    expect(row.target).toBe("vector database client");
    expect(row.num_results).toBe(2);
    expect(row.credits_cost).toBe(0);
    expect(row.is_successful).toBe(true);
    expect(row.options.origin).toBe("sdk");
    expect(row.options.integration).toBe("cli");
    expect(row.options.api_version).toBe("v2");
    expect(row.options.categories).toEqual([{ type: "developer" }]);
    expect(row.options.via).toBe("search_category");
    expect(row.request_id).toBe(res.json.mock.calls[0][0].id);
  });

  it("counts alias category inputs the same as developer", async () => {
    for (const alias of ["repo", "code", "docs", "developer_index"]) {
      mockLogResearchEndpoint.mockClear();
      const req = makeReq({
        query: "http client",
        categories: [alias],
        origin: "sdk",
      });
      const res = makeRes();

      await searchController(req, res);
      await flushAsync();

      expect(res.status).toHaveBeenCalledWith(200);
      expect(mockLogResearchEndpoint).toHaveBeenCalledTimes(1);
      const row = mockLogResearchEndpoint.mock.calls[0][0];
      expect(row.table).toBe("code_searches");
      expect(row.options.categories).toEqual([{ type: "developer" }]);
    }
  });

  it("writes no row for a search without the developer category", async () => {
    mockExecuteSearch.mockResolvedValue(
      executeResult({ response: { web: [] } }),
    );

    for (const categories of [undefined, ["github"]]) {
      mockLogResearchEndpoint.mockClear();
      const req = makeReq({
        query: "http client",
        ...(categories ? { categories } : {}),
      });
      const res = makeRes();

      await searchController(req, res);
      await flushAsync();

      expect(res.status).toHaveBeenCalledWith(200);
      expect(mockLogResearchEndpoint).not.toHaveBeenCalled();
    }
  });

  it("uses the x-origin header when the body has no origin", async () => {
    const req = makeReq(
      { query: "http client", categories: ["developer"] },
      { "x-origin": "mcp-server" },
    );
    const res = makeRes();

    await searchController(req, res);
    await flushAsync();

    expect(mockLogResearchEndpoint).toHaveBeenCalledTimes(1);
    const row = mockLogResearchEndpoint.mock.calls[0][0];
    expect(row.options.origin).toBe("mcp-server");
  });

  it("prefers the body origin over the x-origin header", async () => {
    const req = makeReq(
      { query: "http client", categories: ["developer"], origin: "website" },
      { "x-origin": "mcp-server" },
    );
    const res = makeRes();

    await searchController(req, res);
    await flushAsync();

    const row = mockLogResearchEndpoint.mock.calls[0][0];
    expect(row.options.origin).toBe("website");
  });

  it("falls back to api when neither body origin nor header is present", async () => {
    const req = makeReq({ query: "http client", categories: ["developer"] });
    const res = makeRes();

    await searchController(req, res);
    await flushAsync();

    const row = mockLogResearchEndpoint.mock.calls[0][0];
    expect(row.options.origin).toBe("api");
  });

  it("records zero results when the developer arm returns nothing", async () => {
    mockExecuteSearch.mockResolvedValue(
      executeResult({ response: { web: [] }, totalResultsCount: 0 }),
    );
    const req = makeReq({ query: "http client", categories: ["developer"] });
    const res = makeRes();

    await searchController(req, res);
    await flushAsync();

    expect(mockLogResearchEndpoint).toHaveBeenCalledTimes(1);
    expect(mockLogResearchEndpoint.mock.calls[0][0].num_results).toBe(0);
  });

  it("keeps the response unchanged when the ledger write fails", async () => {
    mockLogResearchEndpoint.mockRejectedValue(new Error("ledger down"));
    const req = makeReq({
      query: "vector database client",
      categories: ["developer"],
    });
    const res = makeRes();

    await searchController(req, res);
    await flushAsync();

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.success).toBe(true);
    expect(body.data.developer).toEqual(developerResults);
    expect(body.creditsUsed).toBe(2);
  });
});
