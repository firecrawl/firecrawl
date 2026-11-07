import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  generateObject: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
  incr: vi.fn(),
  expire: vi.fn(),
}));

const config = vi.hoisted(() => ({
  ALEXANDRIA_INLINE_TOOLS_DAILY_CAP: 2,
  ANTHROPIC_API_KEY: "key" as string | undefined,
  TYPESAFE_API_KEY: undefined,
}));

vi.mock("ai", () => ({ generateObject: mocks.generateObject }));
vi.mock("../config", () => ({ config }));
vi.mock("../lib/generic-ai", () => ({ getModel: vi.fn(() => "model") }));
vi.mock("../lib/typesafe", () => ({ getTypeSafeClient: () => null }));
vi.mock("../services/rate-limiter", () => ({
  redisRateLimitClient: {
    get: mocks.get,
    set: mocks.set,
    incr: mocks.incr,
    expire: mocks.expire,
  },
}));

import { runInlineTools, valueFromQuery } from "./inline-tools";

const logger = { warn: vi.fn(), info: vi.fn() } as any;

const tool = (
  provider: string,
  capability: string,
  options: { name: string; type: string; required?: boolean }[],
  creditsCost = 5,
) => ({
  provider,
  capability,
  name: capability,
  description: provider + " " + capability,
  creditsCost,
  perRecord: false,
  options,
  response: { about: "", key: "", fields: [] },
});

const quote = tool("finance-yahoo-com", "equities/quote", [
  { name: "symbol", type: "string", required: true },
]);
const ticker = tool("api-exchange-coinbase-com", "markets/get_ticker", [
  { name: "product_id", type: "string", required: true },
]);

const answer = (data: unknown, creditsCost = 5) => ({
  status: 200,
  body: {
    success: true,
    creditsCost,
    results: [{ creditsCost, data }],
  },
});

const routed = (anyProvider: number, ...ids: string[]) => ({
  anyProvider,
  providers: ids.map(id => ({ id, probability: 0.9 })),
});

function run(
  query: string,
  found: unknown[],
  route: unknown = routed(0.95, found[0] ? (found[0] as any).provider : "x"),
  retrieve = vi.fn(
    async (..._args: unknown[]): Promise<any> => answer({ price: 1 }),
  ),
) {
  const discover = vi.fn(async () => found as any);
  return {
    retrieve,
    discover,
    result: runInlineTools(
      {
        query,
        teamId: "team",
        deadline: Date.now() + 2500,
        route: async () => route as any,
        discover,
        retrieve,
      },
      logger,
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  config.ANTHROPIC_API_KEY = "key";
  mocks.get.mockResolvedValue(null);
  mocks.set.mockResolvedValue("OK");
  mocks.incr.mockResolvedValue(1);
  mocks.expire.mockResolvedValue(1);
});

describe("valueFromQuery", () => {
  it("reads tickers, URLs, domains and company names", () => {
    expect(valueFromQuery("symbol", "NVDA stock price")).toBe("NVDA");
    expect(valueFromQuery("ticker", "price of $BRK-B today")).toBe("BRK-B");
    expect(valueFromQuery("url", "stats for https://x.com/a")).toBe(
      "https://x.com/a",
    );
    expect(valueFromQuery("domain", "traffic for stripe.com")).toBe(
      "stripe.com",
    );
    expect(valueFromQuery("company_name", "jobs at Stripe")).toBe("Stripe");
    expect(valueFromQuery("symbol", "how to center a div")).toBeUndefined();
  });
});

describe("runInlineTools", () => {
  it("does nothing when the router is unavailable", async () => {
    const { result, discover } = run("NVDA stock price", [quote], undefined);
    expect((await result).skipped).toBe("unrouted");
    expect(discover).not.toHaveBeenCalled();
  });

  it("does nothing below the router's any-provider gate", async () => {
    const { result, retrieve } = run(
      "how to center a div",
      [quote],
      routed(0.4, "finance-yahoo-com"),
    );
    expect((await result).skipped).toBe("not_needed");
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("takes the first allowlisted routed provider", async () => {
    const { result, discover } = run(
      "NVDA stock price",
      [quote],
      routed(0.95, "benzinga", "finance-yahoo-com"),
    );
    await result;
    expect(discover).toHaveBeenCalledWith(
      ["finance-yahoo-com"],
      expect.any(Number),
    );
  });

  it("skips when no routed provider is allowlisted", async () => {
    const { result, discover } = run(
      "lex fridman podcast episodes",
      [quote],
      routed(0.95, "particle"),
    );
    expect((await result).skipped).toBe("no_eligible_tool");
    expect(discover).not.toHaveBeenCalled();
  });

  it("never runs a tool above the credit cap", async () => {
    const { result, retrieve } = run("NVDA stock price", [
      { ...quote, creditsCost: 15 },
    ]);
    expect((await result).skipped).toBe("no_eligible_tool");
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("fills a ticker without the model and returns the provider data", async () => {
    const { result, retrieve } = run("NVDA stock price", [quote]);
    const outcome = await result;
    expect(mocks.generateObject).not.toHaveBeenCalled();
    expect(retrieve).toHaveBeenCalledWith(
      {
        provider: "finance-yahoo-com",
        capability: "equities/quote",
        options: { symbol: "NVDA" },
      },
      1500,
    );
    expect(outcome).toMatchObject({
      filledBy: "query",
      providerCost: 5,
      results: [
        {
          provider: "finance-yahoo-com",
          capability: "equities/quote",
          data: { price: 1 },
          cached: false,
        },
      ],
    });
  });

  it("asks the model only for options the query cannot fill", async () => {
    mocks.generateObject.mockResolvedValue({
      object: {
        fits: true,
        options: [{ name: "product_id", value: "BTC-USD" }],
      },
    });
    const { result, retrieve } = run("bitcoin price", [ticker]);
    expect((await result).filledBy).toBe("model");
    expect(retrieve).toHaveBeenCalledWith(
      expect.objectContaining({ options: { product_id: "BTC-USD" } }),
      expect.any(Number),
    );
  });

  it("sends a tool whose one-of group the query cannot fill to the model", async () => {
    const repo = {
      ...tool("github-com", "repositories/repo", [
        { name: "repo", type: "string" },
        { name: "url", type: "string" },
      ]),
      requiresOneOf: [["repo", "url"]],
    };
    mocks.generateObject.mockResolvedValue({
      object: { fits: true, options: [{ name: "repo", value: "a/b" }] },
    });
    const { result, retrieve } = run("github stars for a/b", [repo]);
    expect((await result).filledBy).toBe("model");
    expect(retrieve).toHaveBeenCalledWith(
      expect.objectContaining({ options: { repo: "a/b" } }),
      expect.any(Number),
    );
  });

  it("never calls a tool with no options filled", async () => {
    const weather = tool("api-weather-gc-ca", "weather/city_weather", [
      { name: "query", type: "string" },
    ]);
    mocks.generateObject.mockResolvedValue({
      object: { fits: true, options: [] },
    });
    const { result, retrieve } = run("weather tomorrow", [weather]);
    expect((await result).skipped).toBe("declined");
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("honours a model decline and keeps the suggestion", async () => {
    mocks.generateObject.mockResolvedValue({
      object: { fits: false, options: [] },
    });
    const { result, retrieve } = run("bitcoin price", [ticker]);
    const outcome = await result;
    expect(outcome.skipped).toBe("declined");
    expect(outcome.candidates).toEqual([
      expect.objectContaining({ provider: "api-exchange-coinbase-com" }),
    ]);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("declines without a model when an option cannot be filled", async () => {
    config.ANTHROPIC_API_KEY = undefined;
    const { result, retrieve } = run("bitcoin price", [ticker]);
    expect((await result).skipped).toBe("declined");
    expect(mocks.generateObject).not.toHaveBeenCalled();
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("serves a cached response without calling the provider", async () => {
    mocks.get.mockResolvedValue(JSON.stringify({ price: 2 }));
    const { result, retrieve } = run("NVDA stock price", [quote]);
    const outcome = await result;
    expect(outcome.cached).toBe(true);
    expect(outcome.results[0].data).toEqual({ price: 2 });
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("stops at the team's daily cap", async () => {
    mocks.incr.mockResolvedValue(3);
    const { result, retrieve } = run("NVDA stock price", [quote]);
    expect((await result).skipped).toBe("daily_cap");
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("falls back to the suggestion when the provider fails", async () => {
    const { result } = run(
      "NVDA stock price",
      [quote],
      routed(0.95, "finance-yahoo-com"),
      vi.fn(async () => ({ status: 503, body: { success: false } })),
    );
    const outcome = await result;
    expect(outcome.skipped).toBe("provider_failed");
    expect(outcome.results).toEqual([]);
    expect(outcome.candidates).toHaveLength(1);
  });
});
