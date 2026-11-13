vi.mock("../config", async importOriginal => {
  const actual = await importOriginal<typeof import("../config")>();
  return {
    config: {
      ...actual.config,
      FIRE_ENGINE_BETA_URL: "http://fire-engine.test",
    },
  };
});
vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { fire_engine_search } from "./fireEngine";
import { SearchUnavailableError } from "../lib/error";

const fetchMock = vi.fn();

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const result = { url: "https://example.com", title: "t", description: "d" };

describe("fire_engine_search", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns results on success", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, [result]));

    await expect(fire_engine_search("q", { numResults: 5 })).resolves.toEqual([
      result,
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("recovers when the retry after a 5xx succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(reply(502, { error: "search_unavailable" }))
      .mockResolvedValueOnce(reply(200, [result]));

    await expect(fire_engine_search("q", { numResults: 5 })).resolves.toEqual([
      result,
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws when both attempts get a 5xx", async () => {
    fetchMock.mockImplementation(async () =>
      reply(502, { error: "search_unavailable" }),
    );

    await expect(
      fire_engine_search("q", { numResults: 5 }),
    ).rejects.toBeInstanceOf(SearchUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns no results on a 4xx without retrying", async () => {
    fetchMock.mockImplementation(async () =>
      reply(400, { error: "No results found" }),
    );

    await expect(fire_engine_search("q", { numResults: 5 })).resolves.toEqual(
      [],
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts an empty success without retrying", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { success: true, data: [] }));

    await expect(fire_engine_search("q", { numResults: 5 })).resolves.toEqual(
      [],
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not throw when the request is aborted", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });

    await expect(
      fire_engine_search("q", { numResults: 5 }, controller.signal),
    ).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
