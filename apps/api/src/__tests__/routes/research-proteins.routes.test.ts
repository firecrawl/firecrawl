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

const RPUSD3 = {
  success: true,
  release: "2026_04",
  match: "found",
  protein: {
    accession: "Q6P087",
    entryName: "RUSD3_HUMAN",
    gene: "RPUSD3",
    synonyms: [],
    name: "Mitochondrial mRNA pseudouridine synthase RPUSD3",
    organism: {
      taxonId: 9606,
      scientificName: "Homo sapiens",
      commonName: "Human",
    },
    matchedBy: "gene",
    url: "https://www.uniprot.org/uniprotkb/Q6P087/entry",
    subcellularLocation: [
      {
        text: "Mitochondrion matrix",
        note: false,
        evidence: [
          {
            kind: "experimental",
            eco: "ECO:0000269",
            paperId: "pmid:27974379",
          },
        ],
      },
    ],
    function: [],
    goCellularComponent: [
      {
        id: "GO:0005759",
        term: "mitochondrial matrix",
        code: "IDA",
        assignedBy: "FlyBase",
        paperIds: ["pmid:27974379"],
      },
    ],
    paperIds: ["pmid:27974379"],
  },
  notice:
    "Protein data from UniProtKB/Swiss-Prot release 2026_04. Copyright UniProt Consortium, https://www.uniprot.org. CC BY 4.0, https://creativecommons.org/licenses/by/4.0/. No warranty, see https://www.uniprot.org/help/license. Selected fields, reformatted.",
};

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
      }),
    );
  });

  it("is free, takes one daily Research Index call, and logs the row as a protein lookup", async () => {
    const res = await request(app)
      .get("/v2/search/research/proteins")
      .query({ protein: "RPUSD3" });

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
        kind: "research_paper_inspect",
        target_hint: "protein:RPUSD3",
      }),
    );
    expect(mocks.logResearchEndpoint).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        table: "research_paper_inspects",
        target: "protein:RPUSD3",
        options: { protein: "RPUSD3" },
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
        target: "protein:RPUSD3 organism:unicorn",
        options: { protein: "RPUSD3", organism: "unicorn" },
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
