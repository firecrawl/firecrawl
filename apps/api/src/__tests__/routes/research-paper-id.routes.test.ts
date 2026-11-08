import express from "express";
import request from "supertest";
import { createResearchRouter } from "../../controllers/v2/research-proxy";

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

vi.mock("../../lib/index-daily-limit", () => ({
  reserveIndexCalls: async () => ({ ok: true, release: async () => {} }),
  indexDailyLimitRefusal: () => {},
}));

const app = express();
app.use((req: any, _res, next) => {
  req.auth = { team_id: "team-test", plan: "standard" };
  req.acuc = { api_key_id: 4 };
  next();
});
app.use("/v2/search/research", createResearchRouter());

beforeEach(() => {
  upstreamCalls.length = 0;
});

it.each([
  [
    "doi:10.1101/2025.07.31.667845?query=x",
    "/v2/research/papers/doi%3A10.1101%2F2025.07.31.667845",
  ],
  [
    "doi:10.1101%2F2025.07.31.667845?query=x",
    "/v2/research/papers/doi%3A10.1101%2F2025.07.31.667845",
  ],
  [
    "doi:10.1101/2025.07.31.667845/similar?intent=x",
    "/v2/research/papers/doi%3A10.1101%2F2025.07.31.667845/similar",
  ],
  ["pmid:40000000/", "/v2/research/papers/pmid%3A40000000"],
])("forwards paper id %s as one encoded segment", async (path, upstream) => {
  const res = await request(app).get(`/v2/search/research/papers/${path}`);

  expect(res.statusCode).toBe(200);
  expect(upstreamCalls).toEqual([upstream]);
});
