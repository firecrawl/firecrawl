import { beforeEach, expect, it, vi } from "vitest";
vi.mock("../lib/exchange-proxy", async importOriginal => ({
  ...(await importOriginal<typeof import("../lib/exchange-proxy")>()),
  forwardToExchange: vi.fn(),
}));
import { forwardToExchange } from "../lib/exchange-proxy";
import { searchRequestSchema } from "../controllers/v2/types";
import { searchAlexandria } from "./alexandria-source";
const forward = vi.mocked(forwardToExchange);
const logger = { warn: vi.fn() } as any;
const input = {
  query: "podcast conversations",
  source: { type: "alexandria" as const },
  limit: 5,
  teamId: "team",
  hasExtendedCatalogAccess: true,
  requestId: "request-1",
};
const contract = {
  attribution: "Provider attribution",
  provider: "particle",
  capability: "podcasts/episodes/search",
  label: "Episode search",
  whenToUse: "Find episodes by what was said.",
  creditsCost: 15,
  perRecord: false,
  options: [
    { name: "semantic_search", type: "string" },
    { name: "limit", type: "number", default: 3 },
  ],
  requiresOneOf: [["semantic_search", "keyword_search"]],
  returns: {
    key: "data",
    about: "Matching episodes",
    fields: [{ name: "id", type: "string" }],
    paginated: true,
  },
};
const hit = {
  provider: "particle",
  address: contract.capability,
  creditsCost: 15,
  cohorts: ["podcasts"],
  concept: "podcasts",
  similarity: 0.9,
};
const response = (body: unknown, status = 200) => ({
  status,
  requestId: null,
  contentType: "application/json",
  body,
});
beforeEach(() => {
  forward.mockReset();
});

it("accepts simple Alexandria sources and rejects lookup knobs and query-free search", () => {
  expect(
    searchRequestSchema
      .parse({ query: "podcasts", sources: ["web", "alexandria"] })
      .sources.map(source => source.type),
  ).toEqual(["web", "alexandria"]);
  expect(
    searchRequestSchema.safeParse({
      query: "podcasts",
      sources: [{ type: "alexandria" }],
    }).success,
  ).toBe(true);
  for (const source of [
    { type: "alexandria", mode: "browse" },
    { type: "alexandria", level: "tools" },
    { type: "alexandria", providers: ["particle"] },
    { type: "alexandria", expand: ["options"] },
    { type: "alexandria", categories: ["podcasts"] },
    { type: "alexandria", cursor: "next" },
  ])
    expect(
      searchRequestSchema.safeParse({ query: "podcasts", sources: [source] })
        .success,
    ).toBe(false);
  expect(
    searchRequestSchema.safeParse({ sources: ["alexandria"] }).success,
  ).toBe(false);
  expect(
    searchRequestSchema.safeParse({ query: " ", sources: ["alexandria"] })
      .success,
  ).toBe(false);
  expect(
    searchRequestSchema.safeParse({
      query: "q",
      sources: ["alexandria", "exchange-providers"],
    }).success,
  ).toBe(false);
});

it("semantically ranks tools and includes their real contracts and examples without extra source flags", async () => {
  forward
    .mockResolvedValueOnce(response({ capabilities: [hit] }))
    .mockResolvedValueOnce(response(contract));
  const result = await searchAlexandria(input, logger);
  expect(result).toMatchObject({
    status: "available",
    level: "tools",
    mode: "semantic",
    total: 1,
    nextCursor: null,
  });
  expect(result.items[0]).toMatchObject({
    provider: "particle",
    capability: contract.capability,
    name: "Episode search",
    options: contract.options,
    requiresOneOf: contract.requiresOneOf,
    response: contract.returns,
    attribution: contract.attribution,
    creditsCost: 15,
    similarity: 0.9,
  });
  expect(result.items[0]).not.toHaveProperty("next");
  expect(result.items[0]).not.toHaveProperty("example");
  const snippets = result.items[0].examples as Record<string, string>;
  expect(snippets.javascript).toContain(
    '"semantic_search": "<semantic_search>"',
  );
  expect(snippets.javascript).toContain('"x-request-id": requestId');
  expect(snippets.python).toContain('"semantic_search"');
  expect(snippets.curl).toContain("/v2/scrape");
  expect(forward.mock.calls.map(([call]) => call.path)).toEqual([
    "/v1/discover?q=podcast%20conversations&limit=5",
    "/v1/discover/podcasts/particle/podcasts/episodes/search",
  ]);
  for (const [call] of forward.mock.calls)
    expect(call).toMatchObject({
      method: "GET",
      teamId: "team",
      hasExtendedCatalogAccess: true,
      requestId: "request-1",
    });
});

it("generates numeric inputs for integer-array contracts in every example", async () => {
  forward
    .mockResolvedValueOnce(response({ capabilities: [hit] }))
    .mockResolvedValueOnce(
      response({
        ...contract,
        options: [{ name: "ids", type: "integer[]", required: true }],
        requiresOneOf: [],
      }),
    );
  const result = await searchAlexandria(input, logger);
  const snippets = result.items[0].examples as Record<string, string>;
  for (const snippet of Object.values(snippets)) {
    expect(snippet).toMatch(/"ids":\s*\[\s*1\s*\]/);
    expect(snippet).not.toContain("<ids>");
  }
});

it("preserves semantic ordering when contract requests complete out of order", async () => {
  forward.mockImplementation(async call => {
    if (call.path.includes("?"))
      return response({
        capabilities: [
          hit,
          { ...hit, address: "podcasts/search", similarity: 0.7 },
        ],
      });
    if (call.path.endsWith("episodes/search")) {
      await new Promise(resolve => setTimeout(resolve, 10));
      return response(contract);
    }
    return response({ ...contract, capability: "podcasts/search" });
  });
  const result = await searchAlexandria(input, logger);
  expect(result.items.map(item => item.capability)).toEqual([
    "podcasts/episodes/search",
    "podcasts/search",
  ]);
});

it("distinguishes empty matches from unavailable or mismatched contracts", async () => {
  forward.mockResolvedValueOnce(response({ capabilities: [] }));
  expect(await searchAlexandria(input, logger)).toMatchObject({
    status: "available",
    items: [],
    total: 0,
  });
  for (const failed of [
    response({}, 503),
    response({ ...contract, provider: "wrong" }),
    response({ ...contract, options: undefined }),
    response({
      ...contract,
      options: [{ name: "query", type: "string", required: "yes" }],
    }),
    response({
      ...contract,
      options: [{ name: "query", type: "string", oneOf: "invalid" }],
    }),
  ]) {
    forward
      .mockResolvedValueOnce(response({ capabilities: [hit] }))
      .mockResolvedValueOnce(failed);
    expect(await searchAlexandria(input, logger)).toMatchObject({
      status: "unavailable",
      items: [],
      total: null,
    });
  }
  forward.mockResolvedValueOnce(response({}, 503));
  expect(await searchAlexandria(input, logger)).toMatchObject({
    status: "unavailable",
    total: null,
  });
});

it("loads a cohort-less hit through free Find Tools without losing ranked matches", async () => {
  forward.mockImplementation(async call => {
    if (call.path.includes("?"))
      return response({
        capabilities: [
          hit,
          { ...hit, address: "podcasts/search", cohorts: [] },
        ],
      });
    if (call.path === "/v1/retrieve")
      return response({
        success: true,
        creditsCost: 0,
        data: {
          items: [
            {
              ...contract,
              capability: "podcasts/search",
              name: contract.label,
              description: contract.whenToUse,
              response: contract.returns,
    attribution: contract.attribution,
            },
          ],
        },
      });
    return response(contract);
  });
  const result = await searchAlexandria(input, logger);
  expect(result.status).toBe("available");
  expect(result.items.map(item => item.capability)).toEqual([
    "podcasts/episodes/search",
    "podcasts/search",
  ]);
  expect(forward).toHaveBeenCalledWith(
    expect.objectContaining({
      method: "POST",
      path: "/v1/retrieve",
      body: expect.objectContaining({
        provider: "firecrawl-contextual-discovery",
      }),
    }),
  );
});

it("keeps successful contracts in rank order and continues after failed lookups", async () => {
  const addresses = ["first", "broken", "third", "fourth", "fifth", "sixth"];
  forward.mockImplementation(async call => {
    if (call.path.includes("?"))
      return response({
        capabilities: addresses.map(address => ({ ...hit, address })),
      });
    const capability = call.path.split("/").at(-1)!;
    if (capability === "broken") return response({}, 503);
    return response({ ...contract, capability });
  });
  const result = await searchAlexandria({ ...input, limit: 6 }, logger);
  expect(result.status).toBe("available");
  expect(result.items.map(item => item.capability)).toEqual([
    "first",
    "third",
    "fourth",
    "fifth",
    "sixth",
  ]);
  expect(result.total).toBe(5);
  expect(result.warning).toContain("Some tool contracts");
});
