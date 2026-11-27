import express from "express";
import request from "supertest";
import { MockAgent } from "undici";
import { config } from "../../../config";
import { getSecureDispatcher } from "../../../scraper/scrapeURL/engines/utils/safeFetch";
import { coreSearchProviders } from "../../../search/providers";
import { createService } from "../../../service";
import { withService } from "../../../service/testing";
import { searchController } from "../search";

vi.mock(
  "../../../scraper/scrapeURL/engines/utils/safeFetch",
  async importOriginal => ({
    ...(await importOriginal<Record<string, unknown>>()),
    getSecureDispatcher: vi.fn(),
  }),
);

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

const searchService = createService(
  {},
  {
    core: { name: "core", searchProviders: coreSearchProviders },
    logger: { error: vi.fn() },
  },
);
const searxngEndpoint = config.SEARXNG_ENDPOINT;
let upstream: MockAgent;

beforeEach(() => {
  config.SEARXNG_ENDPOINT = undefined;
  upstream = new MockAgent();
  upstream.disableNetConnect();
  vi.mocked(getSecureDispatcher).mockReturnValue(upstream);
});

afterEach(async () => {
  config.SEARXNG_ENDPOINT = searxngEndpoint;
  vi.mocked(getSecureDispatcher).mockReset();
  await upstream.close();
});

async function searchWithUpstreamStatus(status: number) {
  upstream
    .get("https://html.duckduckgo.com")
    .intercept({ path: /^\/html\?/ })
    .reply(status, "<html><body></body></html>");
  const response = await withService(searchService, async () =>
    request(app).post("/v2/search").send({ query: "Firecrawl", limit: 1 }),
  );
  upstream.assertNoPendingInterceptors();
  return response;
}

it("returns HTTP 200 when DuckDuckGo finds no matches", async () => {
  const response = await searchWithUpstreamStatus(200);

  expect(response.status).toBe(200);
  expect(response.body).toEqual({
    success: true,
    data: {},
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
