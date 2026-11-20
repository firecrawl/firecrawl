import express from "express";
import request from "supertest";
import { MockAgent } from "undici";
import { config } from "../../../config";
import { getSecureDispatcher } from "../../../scraper/scrapeURL/engines/utils/safeFetch";
import { searchController } from "../search";

vi.mock(
  "../../../scraper/scrapeURL/engines/utils/safeFetch",
  async importOriginal => ({
    ...(await importOriginal<Record<string, unknown>>()),
    getSecureDispatcher: vi.fn(),
  }),
);

vi.mock("../../../services/billing/credit_billing", () => ({
  billTeam: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../services/logging/log_job", () => ({
  logRequest: vi.fn().mockResolvedValue(undefined),
  logSearch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../lib/tracking", () => ({
  trackSearchRequest: vi.fn().mockResolvedValue(undefined),
  trackSearchResults: vi.fn().mockResolvedValue(undefined),
}));

const app = express();
app.use(express.json());
app.post("/v2/search", (req, res) =>
  searchController(
    Object.assign(req, { auth: { team_id: "self-hosted" } }) as Parameters<
      typeof searchController
    >[0],
    res,
  ),
);

const fireEngineUrl = config.FIRE_ENGINE_BETA_URL;
const searxngEndpoint = config.SEARXNG_ENDPOINT;
let upstream: MockAgent;

beforeEach(() => {
  config.FIRE_ENGINE_BETA_URL = undefined;
  config.SEARXNG_ENDPOINT = undefined;
  upstream = new MockAgent();
  upstream.disableNetConnect();
  vi.mocked(getSecureDispatcher).mockReturnValue(upstream);
});

afterEach(async () => {
  config.FIRE_ENGINE_BETA_URL = fireEngineUrl;
  config.SEARXNG_ENDPOINT = searxngEndpoint;
  vi.mocked(getSecureDispatcher).mockReset();
  await upstream.close();
});

async function searchWithUpstreamStatus(status: number) {
  upstream
    .get("https://html.duckduckgo.com")
    .intercept({ path: /^\/html\?/ })
    .reply(status, "<html><body></body></html>");
  const response = await request(app)
    .post("/v2/search")
    .send({ query: "Firecrawl", limit: 1 });
  upstream.assertNoPendingInterceptors();
  return response;
}

it("returns HTTP 200 with zero credits when DuckDuckGo finds no matches", async () => {
  const response = await searchWithUpstreamStatus(200);

  expect(response.status).toBe(200);
  expect(response.body).toEqual({
    success: true,
    data: {},
    creditsUsed: 0,
    id: expect.any(String),
  });
});

it("returns HTTP 502 when DuckDuckGo rejects the request with HTTP 429", async () => {
  const response = await searchWithUpstreamStatus(429);

  expect(response.status).toBe(502);
  expect(response.body).toEqual({
    success: false,
    error: "Search provider request failed.",
  });
});
