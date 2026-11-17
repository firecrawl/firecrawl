vi.mock("../../config", async importOriginal => {
  const actual = await importOriginal<typeof import("../../config")>();
  return {
    config: {
      ...actual.config,
      FIRE_ENGINE_BETA_URL: "http://fire-engine.test",
    },
  };
});
vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { fire_engine_search_v2 } from "./fireEngine-v2";
import { SearchUnavailableError } from "../../lib/error";

const fetchMock = vi.fn();

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const run = () =>
  fire_engine_search_v2("query", { numResults: 5, type: ["web", "news"] });

describe("fire_engine_search_v2", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns results on success", async () => {
    fetchMock.mockResolvedValueOnce(
      reply(200, { web: [{ url: "https://example.com", title: "t" }] }),
    );

    await expect(run()).resolves.toEqual({
      web: [{ url: "https://example.com", title: "t" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws after one retry when search keeps failing", async () => {
    fetchMock.mockImplementation(async () =>
      reply(502, { error: "search_unavailable" }),
    );

    await expect(run()).rejects.toBeInstanceOf(SearchUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws when fire-engine is unreachable", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    await expect(run()).rejects.toBeInstanceOf(SearchUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("recovers when the retry succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(reply(502, { error: "search_unavailable" }))
      .mockResolvedValueOnce(reply(200, { web: [] }));

    await expect(run()).resolves.toEqual({ web: [] });
  });

  it("keeps a 4xx reply as an empty result", async () => {
    fetchMock.mockImplementation(async () =>
      reply(400, { error: "Failed to fetch search results" }),
    );

    await expect(run()).resolves.toEqual({});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("passes known failed types through, outside the result groups", async () => {
    fetchMock.mockResolvedValueOnce(
      reply(200, { web: [], news: [], failedTypes: ["news", "bogus"] }),
    );

    await expect(run()).resolves.toEqual({
      web: [],
      news: [],
      failedTypes: ["news"],
    });
  });
});
