import express from "express";
import request from "supertest";
import { vi } from "vitest";
import type { executeSearch } from "../../../search/execute";

const mockExecuteSearch = vi.fn<typeof executeSearch>();

vi.mock("../../../search/execute", () => ({
  executeSearch: (...args: Parameters<typeof executeSearch>) =>
    mockExecuteSearch(...args),
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

async function searchContextFor(
  caller?: { teamId: string; planClass?: "free" | "self_serve" | "contract" },
  teamId = TEAM_ID,
) {
  const app = express();
  app.use(express.json());
  app.post("/v2/search", async (req, res) => {
    const authedReq = Object.assign(req, {
      auth: { team_id: teamId },
      caller,
    });
    await searchController(authedReq, res);
  });

  const response = await request(app)
    .post("/v2/search")
    .send({ query: "firecrawl" });
  expect(response.status).toBe(200);

  expect(mockExecuteSearch).toHaveBeenCalledTimes(1);
  const context = mockExecuteSearch.mock.calls[0]?.[1];
  if (!context) {
    throw new Error("Expected executeSearch context");
  }
  return context;
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
    resultCountsBySource: { web: 0, news: 0, images: 0 },
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
