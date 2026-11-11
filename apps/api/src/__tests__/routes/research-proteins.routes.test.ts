import { readFileSync } from "fs";
import path from "path";
import express from "express";
import request from "supertest";
import { createResearchRouter } from "../../controllers/v2/research-proxy";

const mocks = vi.hoisted(() => ({
  fetchResearchUpstream: vi.fn(),
  logRequest: vi.fn(),
  logResearchEndpoint: vi.fn(),
  reserveIndexCalls: vi.fn(),
  billTeam: vi.fn(),
}));

vi.mock("../../lib/research-upstream", () => ({
  fetchResearchUpstream: mocks.fetchResearchUpstream,
}));

vi.mock("../../services/logging/log_job", () => ({
  logRequest: mocks.logRequest,
  logResearchEndpoint: mocks.logResearchEndpoint,
}));

vi.mock("../../lib/keyless", () => ({
  chargeKeylessCredits: async () => {},
}));

vi.mock("../../lib/index-daily-limit", () => ({
  reserveIndexCalls: mocks.reserveIndexCalls,
  indexDailyLimitRefusal: () => {},
}));

vi.mock("../../services/billing/credit_billing", () => ({
  billTeam: mocks.billTeam,
}));

const RPUSD3 = JSON.parse(
  readFileSync(path.join(__dirname, "../../../openapi.json"), "utf8"),
).paths["/search/research/proteins"].get.responses["200"].content[
  "application/json"
].example;

function upstream(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(),
    text: async () => JSON.stringify(body),
  };
}

const app = express();
app.use((req: any, _res, next) => {
  req.auth = { team_id: "team-test", plan: "standard" };
  req.acuc = { api_key_id: 4 };
  next();
});
app.use("/v2/search/research", createResearchRouter());
app.use("/v2/research", createResearchRouter({ legacy: true }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.logRequest.mockResolvedValue(undefined);
  mocks.logResearchEndpoint.mockResolvedValue(undefined);
  mocks.billTeam.mockResolvedValue(undefined);
  mocks.reserveIndexCalls.mockResolvedValue({
    ok: true,
    release: async () => {},
  });
  mocks.fetchResearchUpstream.mockResolvedValue(upstream(200, RPUSD3));
});

describe("GET /v2/search/research/proteins", () => {
  it("forwards the protein and organism and returns the upstream answer unchanged", async () => {
    const res = await request(app)
      .get("/v2/search/research/proteins")
      .query({ protein: " RPUSD3 ", organism: "9606" });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(RPUSD3);
    expect(mocks.fetchResearchUpstream).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        path: "/v2/research/proteins",
        params: { protein: "RPUSD3", organism: "9606" },
        queryKeys: ["protein", "organism"],
        timeoutMs: 5_000,
      }),
    );
  });

  it("is free and takes one call from the daily Research Index limit", async () => {
    const res = await request(app)
      .get("/v2/search/research/proteins")
      .query({ protein: "RPUSD3", organism: "9606" });

    expect(res.statusCode).toBe(200);
    expect(mocks.billTeam).not.toHaveBeenCalled();
    expect(mocks.reserveIndexCalls).toHaveBeenCalledExactlyOnceWith(
      "research",
      "team-test",
      1,
      1,
    );
    expect(mocks.logRequest).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        kind: "research_protein_lookup",
        target_hint: "RPUSD3 (9606)",
      }),
    );
    expect(mocks.logResearchEndpoint).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        table: "research_protein_lookups",
        target: "RPUSD3 (9606)",
        credits_cost: 0,
        is_successful: true,
      }),
    );
  });

  it.each([
    ["no protein", {}],
    ["a blank protein", { protein: "   " }],
    ["a protein over 200 characters", { protein: "A".repeat(201) }],
    ["an empty organism", { protein: "RPUSD3", organism: "" }],
  ])("refuses %s with a 400 before any upstream call", async (_name, query) => {
    const res = await request(app)
      .get("/v2/search/research/proteins")
      .query(query);

    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
    expect(mocks.reserveIndexCalls).not.toHaveBeenCalled();
    expect(mocks.fetchResearchUpstream).not.toHaveBeenCalled();
  });

  it("passes an upstream 400 through with its message", async () => {
    const refusal = {
      success: false,
      code: "BAD_REQUEST",
      error:
        "unknown organism 'unicorn': pass an NCBI taxon ID such as 9606, a scientific name such as Homo sapiens, or a UniProt common name such as Human",
    };
    mocks.fetchResearchUpstream.mockResolvedValue(upstream(400, refusal));

    const res = await request(app)
      .get("/v2/search/research/proteins")
      .query({ protein: "RPUSD3", organism: "unicorn" });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual(refusal);
    expect(mocks.logResearchEndpoint).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        is_successful: false,
        error: refusal.error,
      }),
    );
  });

  it("is not served from the legacy research mount", async () => {
    const res = await request(app)
      .get("/v2/research/proteins")
      .query({ protein: "RPUSD3" });

    expect(res.statusCode).toBe(404);
    expect(mocks.fetchResearchUpstream).not.toHaveBeenCalled();
  });
});
