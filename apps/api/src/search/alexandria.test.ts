import { describe, it, expect, vi, beforeEach } from "vitest";
import { discoverTools } from "./alexandria";
import { exchangeRequest } from "../services/alexandria/client";
vi.mock("../services/alexandria/client", () => ({ exchangeRequest: vi.fn() }));
const request = vi.mocked(exchangeRequest);
const logger = { warn: vi.fn() } as any;
const next = {
  provider: "firecrawl",
  capability: "find-tools",
  options: {
    providers: ["sample"],
    capabilities: ["records/search"],
    expand: ["options", "response", "examples"],
  },
};
const tool = {
  provider: "sample",
  capability: "records/search",
  name: "Records",
  description: "Search records",
  creditsCost: 5,
  perRecord: false,
  options: [{ name: "query", type: "string" }],
  response: { about: "Records", key: "records", fields: [] },
  example: { query: "test" },
  next,
};
const compact = {
  provider: tool.provider,
  capability: tool.capability,
  description: tool.description,
};
const input = {
  teamId: "team",
  queries: ["records"],
  limit: 5,
  timeoutMs: 10000,
};
beforeEach(() => vi.clearAllMocks());
it.each([undefined, "compact", "summary", "full"] as const)(
  "supports %s discovery detail",
  async toolDetail => {
    request.mockResolvedValue({
      status: 200,
      body: { success: true, creditsCost: 0, data: { items: [tool] } },
    });
    const result = await discoverTools({ ...input, toolDetail }, logger);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0].body).toMatchObject({
      provider: "firecrawl",
      capability: "find-tools",
      options: {
        query: "records",
        expand:
          toolDetail === "full" ? ["options", "response", "examples"] : [],
      },
    });
    if (toolDetail === "compact") {
      expect(result.items).toEqual([{ ...compact, matchedBy: ["semantic"] }]);
      return;
    }
    expect(result.items[0]).toMatchObject({
      id: "sample/records/search",
      matchedBy: ["semantic"],
    });
    if (toolDetail === "full")
      expect(result.items[0]).toMatchObject({
        options: tool.options,
        response: tool.response,
      });
    else {
      expect(result.items[0]).toMatchObject({ next });
      for (const field of ["options", "response", "example"])
        expect(result.items[0]).not.toHaveProperty(field);
    }
  },
);
it("keeps a warning when discovery fails", async () => {
  request.mockResolvedValue({ status: 503, body: {} });
  const result = await discoverTools(input, logger);
  expect(result.items).toEqual([]);
  expect(result.warning).toBeTruthy();
});
it.each([undefined, "compact", "full"] as const)(
  "deduplicates semantic and domain tools with %s detail",
  async toolDetail => {
    request.mockImplementation(async args =>
      args.path === "/v1/skills/resolve"
        ? {
            status: 200,
            body: {
              skills: [
                {
                  id: "sample",
                  matchedDomains: ["example.com"],
                  domainCapabilities: { "example.com": ["records/search"] },
                },
              ],
            },
          }
        : {
            status: 200,
            body: { success: true, creditsCost: 0, data: { items: [tool] } },
          },
    );
    const result = await discoverTools(
      { ...input, toolDetail, urls: ["https://example.com/records"] },
      logger,
    );
    expect(result.items).toHaveLength(1);
    if (toolDetail === "compact") {
      expect(result.items).toEqual([
        { ...compact, matchedBy: ["semantic", "domain"] },
      ]);
      return;
    }
    expect(result.items[0]).toMatchObject({
      matchedBy: ["semantic", "domain"],
      matchedUrls: ["https://example.com/records"],
      next,
    });
    if (toolDetail === "full")
      expect(result.items[0]).toMatchObject({
        options: tool.options,
        response: tool.response,
      });
    else expect(result.items[0]).not.toHaveProperty("options");
    expect(
      request.mock.calls
        .filter(([args]) => args.path === "/v1/retrieve")
        .map(([args]) => (args.body as any).options.expand),
    ).toEqual(
      toolDetail === "full"
        ? [next.options.expand, next.options.expand]
        : [[], []],
    );
  },
);

it("keeps tools when optional navigation is absent, extended or malformed", async () => {
  const variants = [
    undefined,
    { ...next, label: "Inspect" },
    { provider: "firecrawl" },
  ];
  request.mockResolvedValue({
    status: 200,
    body: {
      success: true,
      creditsCost: 0,
      data: {
        items: variants.map((next, i) => ({
          ...tool,
          capability: `records/${i}`,
          next,
        })),
      },
    },
  });
  const result = await discoverTools(input, logger);
  expect(result.items).toHaveLength(3);
  expect(result.warning).toBeUndefined();
  expect(result.items[1]).toHaveProperty("next", { ...next, label: "Inspect" });
  expect(result.items[0]).toMatchObject({ next: undefined });
  expect(result.items[2]).toMatchObject({ next: undefined });
});

it("retries a failed discovery leg once", async () => {
  request
    .mockResolvedValueOnce({ status: 503, body: {} })
    .mockResolvedValueOnce({
      status: 200,
      body: { success: true, creditsCost: 0, data: { items: [tool] } },
    });
  const result = await discoverTools(input, logger);
  expect(logger.warn).toHaveBeenCalledWith(
    "Semantic tool discovery unavailable",
    expect.objectContaining({ attempt: 1 }),
  );
  expect(request).toHaveBeenCalledTimes(2);
  expect(result.items).toHaveLength(1);
  expect(result.warning).toBeUndefined();
  expect(result.unavailable).toBeUndefined();
});

it("reports discovery unavailable when every leg fails", async () => {
  request.mockResolvedValue({ status: 503, body: {} });
  const result = await discoverTools(
    { ...input, urls: ["https://example.com/records"] },
    logger,
  );
  expect(request).toHaveBeenCalledTimes(4);
  expect(result.items).toEqual([]);
  expect(result.warning).toBeTruthy();
  expect(result.unavailable).toBe(true);
});

it("keeps partial results when only one leg fails", async () => {
  request.mockImplementation(async args =>
    args.path === "/v1/skills/resolve"
      ? { status: 503, body: {} }
      : {
          status: 200,
          body: { success: true, creditsCost: 0, data: { items: [tool] } },
        },
  );
  const result = await discoverTools(
    { ...input, urls: ["https://example.com/records"] },
    logger,
  );
  expect(result.items).toHaveLength(1);
  expect(result.warning).toBeTruthy();
  expect(result.unavailable).toBeUndefined();
});

it("interleaves results of several queries by rank", async () => {
  const named = (capability: string) => ({ ...tool, capability });
  request.mockImplementation(async args => {
    const query = (args.body as { options: { query: string } }).options.query;
    return {
      status: 200,
      body: {
        success: true,
        creditsCost: 0,
        data: {
          items:
            query === "first"
              ? [named("a/one"), named("a/two")]
              : [named("b/one"), named("a/one")],
        },
      },
    };
  });
  const result = await discoverTools(
    { ...input, toolDetail: "compact", queries: ["first", "second"] },
    logger,
  );
  expect(result.items.map(item => item.capability)).toEqual([
    "a/one",
    "b/one",
    "a/two",
  ]);
  expect(result.warning).toBeUndefined();
});

it("keeps the results of queries that answered", async () => {
  request.mockImplementation(async args =>
    (args.body as { options: { query: string } }).options.query === "first"
      ? { status: 503, body: {} }
      : {
          status: 200,
          body: { success: true, creditsCost: 0, data: { items: [tool] } },
        },
  );
  const result = await discoverTools(
    { ...input, queries: ["first", "second"] },
    logger,
  );
  expect(result.items).toHaveLength(1);
  expect(result.warning).toBeUndefined();
});

it("reports the tools the Exchange hid from a US-only team", async () => {
  request.mockResolvedValue({
    status: 200,
    body: {
      success: true,
      creditsCost: 0,
      data: { items: [tool], usOnlyExcluded: 3 },
    },
  });
  const result = await discoverTools({ ...input, usOnly: true }, logger);
  expect(request.mock.calls[0][0]).toMatchObject({ usOnly: true });
  expect(result.items).toHaveLength(1);
  expect(result.usOnlyExcluded).toBe(3);
  expect(result).not.toHaveProperty("warning");
});

it("asks Exchange for zero-data-retention providers only, on every leg", async () => {
  request.mockImplementation(async args =>
    args.path === "/v1/skills/resolve"
      ? {
          status: 200,
          body: {
            skills: [
              {
                id: "sample",
                matchedDomains: ["example.com"],
                domainCapabilities: { "example.com": ["records/search"] },
              },
            ],
          },
        }
      : {
          status: 200,
          body: { success: true, creditsCost: 0, data: { items: [tool] } },
        },
  );
  await discoverTools(
    {
      ...input,
      zeroDataRetention: true,
      urls: ["https://example.com/records"],
    },
    logger,
  );
  // The semantic lookup, the domain resolve, and the domain tool lookup.
  const paths = request.mock.calls.map(([args]) => args.path).sort();
  expect(paths).toEqual(["/v1/retrieve", "/v1/retrieve", "/v1/skills/resolve"]);
  for (const [args] of request.mock.calls)
    expect(args).toMatchObject({ zeroDataRetention: true });
});

it("reports no hidden tools when the Exchange hid nothing", async () => {
  request.mockResolvedValue({
    status: 200,
    body: { success: true, creditsCost: 0, data: { items: [tool] } },
  });
  const result = await discoverTools({ ...input, usOnly: true }, logger);
  expect(result.items).toHaveLength(1);
  expect(result).not.toHaveProperty("usOnlyExcluded");
});

it("numbers each lookup's Exchange request id from the caller's prefix", async () => {
  request.mockResolvedValue({
    status: 200,
    body: { success: true, creditsCost: 0, data: { items: [tool] } },
  });
  const exchangeRequestIds = {
    prefix: "search-1:tools:raw",
    sent: [] as string[],
  };
  await discoverTools(
    { ...input, queries: ["first", "second"], exchangeRequestIds },
    logger,
  );
  expect(request.mock.calls.map(([args]) => args.requestId).sort()).toEqual([
    "search-1:tools:raw:1",
    "search-1:tools:raw:2",
  ]);
  expect(exchangeRequestIds.sent.sort()).toEqual([
    "search-1:tools:raw:1",
    "search-1:tools:raw:2",
  ]);
});

it("sends no request id when the caller passes none", async () => {
  request.mockResolvedValue({
    status: 200,
    body: { success: true, creditsCost: 0, data: { items: [tool] } },
  });
  await discoverTools(input, logger);
  expect(request.mock.calls[0][0].requestId).toBeUndefined();
});

describe("how a tool matched", () => {
  const answer = (items: unknown[], reranking?: unknown) => ({
    status: 200,
    body: {
      success: true,
      creditsCost: 0,
      data: { items, ...(reranking === undefined ? {} : { reranking }) },
    },
  });
  const resolved = {
    status: 200,
    body: {
      skills: [
        {
          id: "sample",
          matchedDomains: ["example.com"],
          domainCapabilities: { "example.com": ["records/search"] },
        },
      ],
    },
  };
  const named = (capability: string) => ({ ...tool, capability });
  const queryOf = (args: { body?: unknown }) =>
    (args.body as { options: { query?: string } }).options.query;

  it("marks tools the catalogue ranked for the query", async () => {
    request.mockResolvedValue(
      answer([tool], { status: "reranked", elapsedMs: 291.5 }),
    );
    const result = await discoverTools(
      { ...input, toolDetail: "compact" },
      logger,
    );
    expect(result.items).toEqual([
      { ...compact, matchedBy: ["semantic"], ranked: true },
    ]);
  });

  it("marks tools that are only the nearest matches", async () => {
    request.mockResolvedValue(
      answer([tool], {
        status: "abstained",
        elapsedMs: 170.3,
        ranker: "semantic_fallback",
      }),
    );
    const result = await discoverTools(
      { ...input, toolDetail: "compact" },
      logger,
    );
    expect(result.items).toEqual([
      { ...compact, matchedBy: ["semantic"], ranked: false },
    ]);
  });

  it("leaves ranked unset when the catalogue does not say", async () => {
    request.mockResolvedValue(answer([tool]));
    const result = await discoverTools(
      { ...input, toolDetail: "compact" },
      logger,
    );
    expect(result.items).toEqual([{ ...compact, matchedBy: ["semantic"] }]);
    expect(result.items[0]).not.toHaveProperty("ranked");
  });

  it.each([
    ["a string", "reranked"],
    ["null", null],
    ["a list", []],
    ["an object without a status", { elapsedMs: 12 }],
    ["a status that is not a string", { status: 5 }],
  ])("keeps the lookup when reranking is %s", async (_name, reranking) => {
    request.mockResolvedValue(answer([tool], reranking));
    const result = await discoverTools(
      { ...input, toolDetail: "compact" },
      logger,
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(result.items).toEqual([{ ...compact, matchedBy: ["semantic"] }]);
    expect(result.items[0]).not.toHaveProperty("ranked");
    expect(result.warning).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each(["summary", "full"] as const)(
    "adds ranked to %s items beside matchedBy",
    async toolDetail => {
      request.mockResolvedValue(answer([tool], { status: "abstained" }));
      const result = await discoverTools({ ...input, toolDetail }, logger);
      expect(result.items[0]).toMatchObject({
        id: "sample/records/search",
        matchedBy: ["semantic"],
        matchedUrls: [],
        ranked: false,
      });
    },
  );

  it("gives a domain-only match no ranked field", async () => {
    request.mockImplementation(async args =>
      args.path === "/v1/skills/resolve"
        ? resolved
        : answer([tool], { status: "reranked" }),
    );
    const result = await discoverTools(
      {
        ...input,
        toolDetail: "compact",
        queries: [],
        urls: ["https://example.com/records"],
      },
      logger,
    );
    expect(result.items).toEqual([{ ...compact, matchedBy: ["domain"] }]);
    expect(result.items[0]).not.toHaveProperty("ranked");
    expect(result.items[0]).not.toHaveProperty("matchedUrls");
    expect(result.semanticMatches).toBe(0);
  });

  it("names both legs for a tool found by query and by domain", async () => {
    request.mockImplementation(async args =>
      args.path === "/v1/skills/resolve"
        ? resolved
        : queryOf(args)
          ? answer([tool], { status: "abstained" })
          : answer([tool]),
    );
    const result = await discoverTools(
      {
        ...input,
        toolDetail: "compact",
        urls: ["https://example.com/records"],
      },
      logger,
    );
    expect(result.items).toEqual([
      { ...compact, matchedBy: ["semantic", "domain"], ranked: false },
    ]);
    expect(result.semanticMatches).toBe(1);
  });

  it("marks a tool ranked when any of several queries ranked it", async () => {
    request.mockImplementation(async args =>
      queryOf(args) === "first"
        ? answer([named("a/one"), named("a/two")], { status: "reranked" })
        : queryOf(args) === "second"
          ? answer([named("b/one"), named("a/one")], { status: "abstained" })
          : answer([named("c/one"), named("b/one")]),
    );
    const result = await discoverTools(
      {
        ...input,
        toolDetail: "compact",
        queries: ["second", "first", "third"],
      },
      logger,
    );
    expect(
      result.items.map(item => [
        item.capability,
        "ranked" in item ? item.ranked : undefined,
      ]),
    ).toEqual([
      ["b/one", false],
      ["a/one", true],
      ["c/one", undefined],
      ["a/two", true],
    ]);
    expect(result.items[2]).not.toHaveProperty("ranked");
  });

  it("returns the same tools in the same order whatever the ranking says", async () => {
    const lists = (reranking?: (query?: string) => unknown) =>
      request.mockImplementation(async args =>
        queryOf(args) === "first"
          ? answer([named("a/one"), named("a/two")], reranking?.("first"))
          : answer([named("b/one"), named("a/one")], reranking?.("second")),
      );
    const run = async () =>
      (
        await discoverTools(
          { ...input, toolDetail: "compact", queries: ["first", "second"] },
          logger,
        )
      ).items.map(({ provider, capability, description }) => ({
        provider,
        capability,
        description,
      }));
    const expected = ["a/one", "b/one", "a/two"].map(capability => ({
      ...compact,
      capability,
    }));
    lists();
    expect(await run()).toEqual(expected);
    lists(() => ({ status: "reranked" }));
    expect(await run()).toEqual(expected);
    lists(() => ({ status: "abstained" }));
    expect(await run()).toEqual(expected);
    lists(query => ({ status: query === "first" ? "abstained" : "reranked" }));
    expect(await run()).toEqual(expected);
  });
});
