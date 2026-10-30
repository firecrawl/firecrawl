import express from "express";
import request from "supertest";
import {
  createDeveloperRouter,
  createResearchRouter,
} from "../../controllers/v2/research-proxy";
import { autumnService } from "../../services/autumn/autumn.service";

const upstreamCalls: string[] = [];

vi.mock("../../lib/research-upstream", () => ({
  fetchResearchUpstream: async (options: { path: string }) => {
    upstreamCalls.push(options.path);
    return {
      status: 200,
      ok: true,
      headers: new Headers(),
      text: async () => JSON.stringify({ success: true, results: [] }),
    };
  },
}));

vi.mock("../../services/logging/log_job", () => ({
  logRequest: async () => {},
  logResearchEndpoint: async () => {},
}));

vi.mock("../../lib/keyless", () => ({
  chargeKeylessCredits: async () => {},
}));

vi.mock("../../services/billing/credit_billing", () => ({
  billTeam: async () => {},
}));

vi.mock("../../services/autumn/autumn.service", () => ({
  autumnService: { checkCredits: vi.fn(), mcpCreditsAvailable: vi.fn() },
  CREDITS_FEATURE_ID: "CREDITS",
  SEARCH_CREDITS_FEATURE_ID: "SEARCH_CREDITS",
}));

const checkCredits = vi.mocked(autumnService.checkCredits);
const mcpCreditsAvailable = vi.mocked(autumnService.mcpCreditsAvailable);

function appWith(orgId: string | undefined, hostedMcp = false) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.auth = {
      team_id: "team-test",
      org_id: orgId,
      plan: "standard",
      ...(hostedMcp ? { hostedMcp: true } : {}),
    };
    req.acuc = { api_key_id: 4 };
    next();
  });
  app.use("/v2/search/research", createResearchRouter());
  app.use("/v2/search/developer", createDeveloperRouter({ root: true }));
  app.use("/v2/developer", createDeveloperRouter());
  return app;
}

const app = appWith("org-test");

beforeEach(() => {
  vi.clearAllMocks();
  upstreamCalls.length = 0;
});

describe.each([
  ["developer search", "/v2/search/developer?query=x"],
  ["legacy developer search", "/v2/developer/search?query=x"],
  ["GitHub research search", "/v2/search/research/github?query=x"],
])("%s credit gate", (_name, path) => {
  it("refuses with 402 when the team can't cover a search", async () => {
    checkCredits.mockResolvedValue({ allowed: false, remaining: 0 });

    const res = await request(app).get(path);

    expect(res.statusCode).toBe(402);
    expect(res.body.success).toBe(false);
    expect(upstreamCalls).toEqual([]);
    expect(checkCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: "team-test",
        orgId: "org-test",
        value: 2,
        featureId: "SEARCH_CREDITS",
      }),
    );
  });

  it("serves the request when the team has credits", async () => {
    checkCredits.mockResolvedValue({ allowed: true, remaining: 500 });

    const res = await request(app).get(path);

    expect(res.statusCode).toBe(200);
    expect(upstreamCalls).toHaveLength(1);
  });

  it("fails open when billing can't answer", async () => {
    checkCredits.mockResolvedValue(null);

    const res = await request(app).get(path);

    expect(res.statusCode).toBe(200);
    expect(upstreamCalls).toHaveLength(1);
  });

  it("lets a caller with no org through, as other gates do", async () => {
    const res = await request(appWith(undefined)).get(path);

    expect(res.statusCode).toBe(200);
    expect(checkCredits).not.toHaveBeenCalled();
  });

  it("serves a hosted MCP search the team's MCP credits can cover", async () => {
    checkCredits.mockResolvedValue({ allowed: false, remaining: 0 });
    mcpCreditsAvailable.mockResolvedValue(2);

    const res = await request(appWith("org-test", true)).get(path);

    expect(res.statusCode).toBe(200);
    expect(upstreamCalls).toHaveLength(1);
    expect(mcpCreditsAvailable).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: "team-test", value: 2 }),
    );
  });
});

it("leaves free paper search ungated", async () => {
  checkCredits.mockResolvedValue({ allowed: false, remaining: 0 });

  const res = await request(app).get("/v2/search/research/papers?query=x");

  expect(res.statusCode).toBe(200);
  expect(checkCredits).not.toHaveBeenCalled();
});
