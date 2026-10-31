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
      expect(result.items).toEqual([compact]);
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
      expect(result.items).toEqual([compact]);
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

describe("domain discovery", () => {
  const toolsOf = (provider: string, count: number) =>
    Array.from({ length: count }, (_, i) => ({
      ...tool,
      provider,
      capability: `records/${i}`,
    }));
  const answer = (items: unknown[]) => ({
    status: 200,
    body: { success: true, creditsCost: 0, data: { items } },
  });
  const resolve = (skills: unknown[]) => ({ status: 200, body: { skills } });
  const lookups = () =>
    request.mock.calls
      .filter(([args]) => args.path === "/v1/retrieve")
      .map(([args]) => (args.body as any).options);

  it("ranks a matched provider's tools by the query", async () => {
    request.mockImplementation(async args =>
      args.path === "/v1/skills/resolve"
        ? resolve([{ id: "big", matchedDomains: ["big.example"] }])
        : answer(toolsOf("big", 2)),
    );
    await discoverTools(
      {
        ...input,
        queries: undefined,
        rankQuery: "podcast sponsors",
        urls: ["https://big.example/a"],
      },
      logger,
    );
    expect(lookups()).toEqual([
      expect.objectContaining({
        providers: ["big"],
        query: "podcast sponsors",
      }),
    ]);
  });

  it("falls back to the provider listing when nothing ranks", async () => {
    request.mockImplementation(async args => {
      if (args.path === "/v1/skills/resolve")
        return resolve([{ id: "big", matchedDomains: ["big.example"] }]);
      const options = (args.body as any).options;
      return answer(options.query ? [] : toolsOf("big", 2));
    });
    const result = await discoverTools(
      {
        ...input,
        queries: undefined,
        rankQuery: "nothing relevant",
        urls: ["https://big.example/a"],
      },
      logger,
    );
    expect(lookups()).toHaveLength(2);
    expect(lookups()[1]).not.toHaveProperty("query");
    expect(result.items).toHaveLength(2);
  });

  it("keeps URL-mapped capabilities instead of ranking", async () => {
    request.mockImplementation(async args =>
      args.path === "/v1/skills/resolve"
        ? resolve([
            {
              id: "big",
              matchedDomains: ["big.example"],
              domainCapabilities: { "big.example": ["records/0"] },
            },
          ])
        : answer(toolsOf("big", 1)),
    );
    await discoverTools(
      {
        ...input,
        queries: undefined,
        rankQuery: "records",
        urls: ["https://big.example/a"],
      },
      logger,
    );
    expect(lookups()).toEqual([
      expect.not.objectContaining({ query: expect.anything() }),
    ]);
    expect(lookups()[0]).toMatchObject({ capabilities: ["records/0"] });
  });

  it("shares domain slots across matched providers", async () => {
    request.mockImplementation(async args => {
      if (args.path === "/v1/skills/resolve")
        return resolve([
          { id: "big", matchedDomains: ["big.example"] },
          { id: "small", matchedDomains: ["small.example"] },
        ]);
      const [provider] = (args.body as any).options.providers;
      return answer(toolsOf(provider, provider === "big" ? 5 : 2));
    });
    const result = await discoverTools(
      {
        ...input,
        queries: undefined,
        limit: 4,
        toolDetail: "compact",
        urls: ["https://big.example/a", "https://small.example/b"],
      },
      logger,
    );
    expect(
      result.items.map(item => `${item.provider}/${item.capability}`),
    ).toEqual([
      "big/records/0",
      "small/records/0",
      "big/records/1",
      "small/records/1",
    ]);
  });
  it("keeps other providers when one provider's lookup fails", async () => {
    request.mockImplementation(async args => {
      if (args.path === "/v1/skills/resolve")
        return resolve([
          { id: "broken", matchedDomains: ["broken.example"] },
          { id: "small", matchedDomains: ["small.example"] },
        ]);
      const [provider] = (args.body as any).options.providers;
      return provider === "broken"
        ? { status: 503, body: {} }
        : answer(toolsOf(provider, 1));
    });
    const result = await discoverTools(
      {
        ...input,
        queries: undefined,
        toolDetail: "compact",
        urls: ["https://broken.example/a", "https://small.example/b"],
      },
      logger,
    );
    expect(result.items.map(item => item.provider)).toEqual(["small"]);
    expect(result.warning).toBeTruthy();
    expect(result.unavailable).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      "Domain tool discovery unavailable",
      expect.objectContaining({ attempt: 2 }),
    );
  });
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
