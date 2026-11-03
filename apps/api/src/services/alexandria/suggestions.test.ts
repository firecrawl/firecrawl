const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  config: { FIRE_EXCHANGE_URL: "https://exchange.test" as string | undefined },
}));
vi.mock("./client", () => ({ exchangeRequest: mocks.request }));
vi.mock("../../config", () => ({ config: mocks.config }));
import {
  exchangeUrlSuggestions,
  scrapeErrorWithSuggestions,
} from "./suggestions";

const url = "https://data.similarweb.com/api/v1/data?domain=example.com";
const suggestion = {
  provider: "similarweb",
  capability: "web/traffic",
  reason: "Licensed Similarweb traffic and engagement data for any website.",
  input: { domain: "example.com" },
  creditsCost: 110,
  contractPath: "/v1/discover/web-analytics/similarweb",
};

describe("exchangeUrlSuggestions", () => {
  beforeEach(() => {
    mocks.request.mockReset();
    mocks.config.FIRE_EXCHANGE_URL = "https://exchange.test";
  });

  it("asks the Exchange about one URL and rewrites contract paths to the public proxy", async () => {
    mocks.request.mockResolvedValue({
      status: 200,
      body: {
        url,
        suggestions: [suggestion],
        message: "Alexandria suggestion: …",
      },
    });
    const result = await exchangeUrlSuggestions({ teamId: "team", url });
    expect(mocks.request).toHaveBeenCalledWith({
      teamId: "team",
      path: `/v1/discover/suggestions?url=${encodeURIComponent(url)}`,
      timeoutMs: 1500,
    });
    expect(result).toEqual({
      suggestions: [
        {
          ...suggestion,
          contractPath: "/exchange/discover/web-analytics/similarweb",
        },
      ],
      message: "Alexandria suggestion: …",
    });
  });

  it("fails open", async () => {
    for (const outcome of [
      { status: 500, body: { error: "x" } },
      { status: 200, body: { url, suggestions: [] } },
      { status: 200, body: "not json" },
    ]) {
      mocks.request.mockResolvedValueOnce(outcome);
      expect(
        await exchangeUrlSuggestions({ teamId: "t", url }),
      ).toBeUndefined();
    }
    mocks.request.mockRejectedValueOnce(new Error("timeout"));
    expect(await exchangeUrlSuggestions({ teamId: "t", url })).toBeUndefined();
    mocks.config.FIRE_EXCHANGE_URL = undefined;
    expect(await exchangeUrlSuggestions({ teamId: "t", url })).toBeUndefined();
    expect(mocks.request).toHaveBeenCalledTimes(4);
  });
});

describe("scrapeErrorWithSuggestions", () => {
  const logger = { debug: vi.fn() };
  const failure = {
    teamId: "team",
    url,
    code: "SCRAPE_ALL_ENGINES_FAILED" as const,
    message: "All scraping engines failed to retrieve content from this URL.",
    zeroDataRetention: false,
    logger,
  };

  beforeEach(() => {
    mocks.request.mockReset();
    mocks.config.FIRE_EXCHANGE_URL = "https://exchange.test";
  });

  it("appends the Exchange message and returns the suggestions for access failures", async () => {
    for (const code of [
      "SCRAPE_ALL_ENGINES_FAILED",
      "SCRAPE_SITE_ERROR",
    ] as const) {
      mocks.request.mockResolvedValueOnce({
        status: 200,
        body: {
          url,
          suggestions: [suggestion],
          message: "Alexandria suggestion: use Similarweb.",
        },
      });
      expect(await scrapeErrorWithSuggestions({ ...failure, code })).toEqual({
        error: `${failure.message} Alexandria suggestion: use Similarweb.`,
        alexandriaSuggestions: [
          {
            ...suggestion,
            contractPath: "/exchange/discover/web-analytics/similarweb",
          },
        ],
      });
    }
  });

  it("leaves the error unchanged on empty, failed or timed-out lookups", async () => {
    mocks.request
      .mockResolvedValueOnce({ status: 200, body: { url, suggestions: [] } })
      .mockResolvedValueOnce({ status: 503, body: "unavailable" })
      .mockRejectedValueOnce(
        new DOMException(
          "The operation was aborted due to timeout",
          "TimeoutError",
        ),
      );
    for (let i = 0; i < 3; i++)
      expect(await scrapeErrorWithSuggestions(failure)).toEqual({
        error: failure.message,
      });
    expect(mocks.request).toHaveBeenCalledTimes(3);
    expect(mocks.request).toHaveBeenLastCalledWith(
      expect.objectContaining({ timeoutMs: 1500 }),
    );
  });

  it("does not ask the Exchange for other errors, zero data retention or when unconfigured", async () => {
    expect(
      await scrapeErrorWithSuggestions({ ...failure, code: "SCRAPE_TIMEOUT" }),
    ).toEqual({ error: failure.message });
    expect(
      await scrapeErrorWithSuggestions({ ...failure, zeroDataRetention: true }),
    ).toEqual({ error: failure.message });
    mocks.config.FIRE_EXCHANGE_URL = undefined;
    expect(await scrapeErrorWithSuggestions(failure)).toEqual({
      error: failure.message,
    });
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
