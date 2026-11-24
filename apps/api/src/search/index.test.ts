const mocks = vi.hoisted(() => ({
  fireEngineSearch: vi.fn(),
  searchV2: vi.fn(),
}));

vi.mock("../config", () => ({
  config: { FIRE_ENGINE_BETA_URL: "https://fire-engine.test" },
}));
vi.mock("./fireEngine", () => ({ fire_engine_search: mocks.fireEngineSearch }));
vi.mock("./v2", () => ({ search: mocks.searchV2 }));

import { search } from "./index";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as any;

afterEach(() => {
  vi.clearAllMocks();
});

describe("legacy search", () => {
  it.each(["zdr", "anon"] as const)(
    "sends a forced %s search through the v2 search with its kind",
    async kind => {
      mocks.searchV2.mockResolvedValue({
        web: [
          {
            url: "https://example.com/",
            title: "Example",
            description: "An example",
            position: 1,
          },
        ],
      });

      const results = await search({
        query: "example",
        logger,
        num_results: 5,
        usOnly: false,
        enterprise: [kind],
      });

      expect(mocks.fireEngineSearch).not.toHaveBeenCalled();
      expect(mocks.searchV2).toHaveBeenCalledTimes(1);
      expect(mocks.searchV2.mock.calls[0][0]).toMatchObject({
        query: "example",
        num_results: 5,
        enterprise: [kind],
      });
      expect(results).toEqual([
        {
          url: "https://example.com/",
          title: "Example",
          description: "An example",
        },
      ]);
    },
  );

  it("returns no results when the v2 search finds none", async () => {
    mocks.searchV2.mockResolvedValue({});

    const results = await search({
      query: "example",
      logger,
      enterprise: ["zdr"],
    });

    expect(results).toEqual([]);
    expect(mocks.fireEngineSearch).not.toHaveBeenCalled();
  });

  it("keeps the legacy route when no kind is forced", async () => {
    mocks.fireEngineSearch.mockResolvedValue([]);

    await search({ query: "example", logger, num_results: 5 });

    expect(mocks.searchV2).not.toHaveBeenCalled();
    expect(mocks.fireEngineSearch).toHaveBeenCalledTimes(1);
    expect(mocks.fireEngineSearch.mock.calls[0][0]).toBe("example");
  });
});
