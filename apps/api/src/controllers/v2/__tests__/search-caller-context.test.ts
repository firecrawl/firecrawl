import { vi } from "vitest";

const mockExecuteSearch = vi.fn();
const mockRecordDiscoveredTools = vi.fn();

vi.mock("../../../search/execute", () => ({
  executeSearch: (...args: any[]) => mockExecuteSearch(...args),
}));

vi.mock("../../../lib/alexandria-discovery", () => ({
  recordDiscoveredTools: (...args: any[]) => mockRecordDiscoveredTools(...args),
}));

vi.mock("../../../services/logging/log_job", () => ({
  logRequest: vi.fn().mockResolvedValue(undefined),
  logSearch: vi.fn().mockResolvedValue(undefined),
  logResearchEndpoint: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../services/billing/credit_billing", () => ({
  billTeam: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../lib/keyless", () => ({
  KEYLESS_FREE_TIER_LIMIT_MESSAGE: "keyless limit reached",
  adjustKeylessCredits: vi.fn().mockResolvedValue(undefined),
  keylessLimitBody: vi.fn().mockResolvedValue({ success: false }),
  keylessProviderToolsBody: vi.fn(() => ({ success: false })),
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

vi.mock("../../../lib/alexandria-activity", () => ({
  markAlexandriaActivity: vi.fn(),
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
const tools = [
  {
    provider: "open-meteo",
    capability: "forecast/daily",
    description: "Daily forecast",
  },
];
const lineage = Buffer.from(
  JSON.stringify({
    session_id: "sess_01A",
    session_source: "token",
    thread_id: "thread:42.a-b",
    thread_source: "client",
  }),
).toString("base64url");

/** Runs one search that shows tools and returns the context it ran with. */
async function searchContextFor(request: {
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  hostedMcp?: boolean;
  flags?: Record<string, unknown>;
}) {
  const res: any = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  await searchController(
    {
      body: { query: "weather in Lisbon", ...request.body },
      headers: request.headers ?? {},
      auth: { team_id: TEAM_ID, hostedMcp: request.hostedMcp ?? true },
      acuc: { api_key_id: 7, flags: request.flags ?? {} },
    } as any,
    res,
  );
  expect(res.status).toHaveBeenCalledWith(200);
  expect(mockExecuteSearch).toHaveBeenCalledTimes(1);
  return mockExecuteSearch.mock.calls[0][1];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExecuteSearch.mockResolvedValue({
    response: { web: [], tools },
    toolsAuto: true,
    toolFusion: false,
    totalResultsCount: 0,
    indexResultsCount: 0,
    searchCredits: 0,
    scrapeCredits: 0,
    totalCredits: 0,
    shouldScrape: false,
  });
});

describe("the caller a v2 search names", () => {
  it("carries a hosted MCP caller's session and conversation into the search and what it records", async () => {
    const context = await searchContextFor({
      headers: { "x-firecrawl-mcp-lineage": lineage },
    });

    expect(context).toMatchObject({
      clientSession: "sess_01A",
      clientThread: "thread:42.a-b",
    });
    expect(mockRecordDiscoveredTools).toHaveBeenCalledExactlyOnceWith(
      TEAM_ID,
      "auto_search",
      context.jobId,
      tools,
      { sessionId: "sess_01A", threadId: "thread:42.a-b" },
    );
  });

  it.each([
    ["a caller that is not the hosted MCP", { hostedMcp: false }],
    [
      "a team held to Alexandria zero data retention",
      {
        flags: { alexandriaZDR: "forced" },
      },
    ],
  ])("names no session or conversation for %s", async (_name, request) => {
    const context = await searchContextFor({
      ...request,
      headers: { "x-firecrawl-mcp-lineage": lineage },
    });

    expect(context.clientSession).toBeUndefined();
    expect(context.clientThread).toBeUndefined();
    expect(mockRecordDiscoveredTools).toHaveBeenCalledExactlyOnceWith(
      TEAM_ID,
      "auto_search",
      context.jobId,
      tools,
      {},
    );
  });

  it("names the origin the request gave, in its body or its header, and none otherwise", async () => {
    const named = await searchContextFor({
      body: { origin: "mcp-cursor" },
      headers: { "x-origin": "cli" },
    });
    expect(named.clientOrigin).toBe("mcp-cursor");

    mockExecuteSearch.mockClear();
    const header = await searchContextFor({ headers: { "x-origin": "cli" } });
    expect(header.clientOrigin).toBe("cli");

    mockExecuteSearch.mockClear();
    const unnamed = await searchContextFor({});
    expect(unnamed.clientOrigin).toBeUndefined();
    expect(unnamed.origin).toBe("api");
  });
});
