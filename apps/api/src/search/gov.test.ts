vi.mock("undici", () => ({
  Agent: class {},
  fetch: vi.fn(),
}));

vi.mock("../config", () => ({
  config: { SEARCH_PLATFORM_URL: "https://platform.test/" },
}));

import { fetch } from "undici";
import { searchGovCategory } from "./gov";

const fetchMock = vi.mocked(fetch);

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as any;

function upstreamOk(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as any;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("searchGovCategory", () => {
  it("sends the query, the result count and the team", async () => {
    fetchMock.mockResolvedValue(
      upstreamOk({ success: true, data: { web: [] } }),
    );

    await searchGovCategory(
      { query: "food labeling rules", limit: 7, teamId: "t1", timeout: 500 },
      logger,
    );

    const [url, init] = fetchMock.mock.calls[0] as any[];
    expect(url).toBe("https://platform.test/api/v1/gov-search");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      query: "food labeling rules",
      top_k: 7,
    });
    expect(init.headers["firecrawl-team-id"]).toBe("t1");
  });

  it("maps results to the exact web schema and tags the category", async () => {
    fetchMock.mockResolvedValue(
      upstreamOk({
        success: true,
        data: {
          web: [
            {
              url: "https://www.ecfr.gov/current/title-21/part-101",
              title: "21 CFR Part 101",
              description: "Food labeling",
              position: 42,
              score: 0.9,
            },
            { url: "", title: "dropped", description: "", position: 43 },
            {
              url: "https://www.ecfr.gov/current/title-21/part-102",
              title: "  ",
              position: 44,
            },
          ],
        },
      }),
    );

    const results = await searchGovCategory(
      { query: "food labeling", limit: 5, teamId: "t1", timeout: 500 },
      logger,
    );

    expect(results).toStrictEqual([
      {
        url: "https://www.ecfr.gov/current/title-21/part-101",
        title: "21 CFR Part 101",
        description: "Food labeling",
        position: 1,
        category: "gov",
      },
      {
        url: "https://www.ecfr.gov/current/title-21/part-102",
        title: "https://www.ecfr.gov/current/title-21/part-102",
        description: "",
        position: 3,
        category: "gov",
      },
    ]);
  });

  it("returns no results and drains the body when the upstream fails", async () => {
    const cancel = vi.fn(async () => {});
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      body: { cancel },
    } as any);

    await expect(
      searchGovCategory(
        { query: "zoning", limit: 5, teamId: "t1", timeout: 500 },
        logger,
      ),
    ).resolves.toEqual([]);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("returns no results when the upstream throws", async () => {
    fetchMock.mockRejectedValue(new Error("connection reset"));

    await expect(
      searchGovCategory(
        { query: "zoning", limit: 5, teamId: "t1", timeout: 500 },
        logger,
      ),
    ).resolves.toEqual([]);
  });
});
