vi.mock("undici", () => ({
  Agent: class {},
  fetch: vi.fn(),
}));

vi.mock("../config", () => ({
  config: { RESEARCH_PROXY_URL: "https://research.test/" },
}));

import { fetch } from "undici";
import { searchDeveloperCategory, wantsDeveloperCategory } from "./developer";

const fetchMock = vi.mocked(fetch);

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as any;

function upstreamOk(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as any;
}

function firstCall(): any[] {
  return fetchMock.mock.calls[0] as any[];
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("wantsDeveloperCategory", () => {
  it("reads both the string form and the object form", () => {
    expect(wantsDeveloperCategory(["developer"])).toBe(true);
    expect(wantsDeveloperCategory([{ type: "developer" }])).toBe(true);
    expect(wantsDeveloperCategory(["github", "research"])).toBe(false);
    expect(wantsDeveloperCategory(undefined)).toBe(false);
  });
});

describe("searchDeveloperCategory", () => {
  it("sends the query and the result count, and nothing else", async () => {
    fetchMock.mockResolvedValue(upstreamOk({ results: [] }));

    await searchDeveloperCategory(
      { query: '"exact phrase" retries', limit: 7, teamId: "t1", timeout: 500 },
      logger,
    );

    const url = firstCall()[0] as URL;
    expect(url.pathname).toBe("/v2/code/search");
    expect(url.searchParams.get("query")).toBe('"exact phrase" retries');
    expect(url.searchParams.get("k")).toBe("7");
    expect([...url.searchParams.keys()]).toEqual(["query", "k"]);
    expect(url.searchParams.has("skills")).toBe(false);
    expect(firstCall()[1].method).toBe("GET");
    expect(firstCall()[1].headers).toEqual({ "firecrawl-team-id": "t1" });
  });

  it("pseudonymizes a keyless team before sending the upstream header", async () => {
    fetchMock.mockResolvedValue(upstreamOk({ results: [] }));

    await searchDeveloperCategory(
      {
        query: "retries",
        limit: 7,
        teamId: "preview_keyless_203.0.113.8",
        timeout: 500,
      },
      logger,
    );

    expect(firstCall()[1].headers).toEqual({
      "firecrawl-team-id": "preview_keyless_sha256_ddbea5471056690e5b1dcfe0",
    });
  });

  it("maps results to the exact web schema and leaks nothing upstream", async () => {
    const license = { state: "licensed", spdx_id: "MIT" };
    fetchMock.mockResolvedValue(
      upstreamOk({
        results: [
          {
            id: "issue:a/b#1",
            url: "https://github.com/a/b/issues/1",
            title: "Retries drop the backoff",
            passages: [
              { text: "first passage", citation_url: "https://example.com" },
            ],
            license,
          },
          { id: "readme:a/b", url: "", passages: [] },
        ],
      }),
    );

    const results = await searchDeveloperCategory(
      { query: "retries", limit: 5, teamId: "t1", timeout: 500 },
      logger,
    );

    // Exact WebSearchResult shape: the upstream id/passages/license must not
    // appear on the wire; the first passage becomes the description.
    expect(results).toStrictEqual([
      {
        url: "https://github.com/a/b/issues/1",
        title: "Retries drop the backoff",
        description: "first passage",
        position: 1,
        category: "developer",
      },
    ]);
  });

  it("falls back to the url when the upstream sends no usable title", async () => {
    fetchMock.mockResolvedValue(
      upstreamOk({
        results: [
          {
            id: "abc",
            type: "pull_request",
            url: "https://github.com/a/b/pull/1",
            passages: [{ text: "first passage" }],
          },
          {
            id: "def",
            type: "pull_request",
            url: "https://github.com/a/b/pull/2",
            title: "   ",
            passages: [],
          },
        ],
      }),
    );

    const results = await searchDeveloperCategory(
      { query: "retries", limit: 5, teamId: "t1", timeout: 500 },
      logger,
    );

    expect(results.map(result => result.title)).toEqual([
      "https://github.com/a/b/pull/1",
      "https://github.com/a/b/pull/2",
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
      searchDeveloperCategory(
        { query: "retries", limit: 5, teamId: "t1", timeout: 500 },
        logger,
      ),
    ).resolves.toEqual([]);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("returns no results when the upstream throws", async () => {
    fetchMock.mockRejectedValue(new Error("connection reset"));

    await expect(
      searchDeveloperCategory(
        { query: "retries", limit: 5, teamId: "t1", timeout: 500 },
        logger,
      ),
    ).resolves.toEqual([]);
  });
});
