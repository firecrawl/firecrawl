import { vi } from "vitest";

const mockExecuteSearch = vi.fn();

vi.mock("../../../search/execute", () => ({
  executeSearch: (...args: any[]) => mockExecuteSearch(...args),
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
import { createService, replaceService } from "../../../service/service";

const TEAM_ID = "11111111-1111-1111-1111-111111111111";

function makeRes() {
  const res: any = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

async function searchContextFor(
  caller?: { teamId: string; planClass?: "free" | "self_serve" | "contract" },
  teamId = TEAM_ID,
) {
  const req: any = {
    body: { query: "firecrawl" },
    headers: {},
    auth: { team_id: teamId },
    caller,
  };

  const res = makeRes();
  await searchController(req, res);
  expect(res.status).toHaveBeenCalledWith(200);

  expect(mockExecuteSearch).toHaveBeenCalledTimes(1);
  return mockExecuteSearch.mock.calls[0][1];
}

beforeEach(() => {
  vi.clearAllMocks();
  replaceService(
    createService({}, { core: { name: "core" }, logger: { error: vi.fn() } }),
  );
  mockExecuteSearch.mockResolvedValue({
    response: { web: [] },
    totalResultsCount: 0,
    billableResultsCount: 0,
    indexResultsCount: 0,
    threatDecisions: [],
    scrapedDocuments: [],
    searchTypes: ["web"],
    scrapeFormats: [],
    resultCountsBySource: {},
    resultCategories: {},
    toolFusion: false,
    shouldScrape: false,
  });
});

afterEach(() => {
  replaceService(undefined);
});

describe("the team plan class a v2 search runs with", () => {
  it.each(["free", "self_serve", "contract"] as const)(
    "forwards %s from req.caller.planClass into executeSearch",
    async planClass => {
      const context = await searchContextFor({
        teamId: TEAM_ID,
        planClass,
      });

      expect(context.teamPlanClass).toBe(planClass);
    },
  );

  it("is not stated when caller carries no planClass", async () => {
    const context = await searchContextFor({ teamId: TEAM_ID });

    expect(context).toHaveProperty("teamPlanClass", undefined);
  });

  it("is not stated without a caller", async () => {
    const context = await searchContextFor(undefined);

    expect(context).toHaveProperty("teamPlanClass", undefined);
  });
});
