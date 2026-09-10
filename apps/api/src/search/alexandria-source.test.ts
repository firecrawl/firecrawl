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
  expect(snippets.curl).toContain("/exchange/retrieve");
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
