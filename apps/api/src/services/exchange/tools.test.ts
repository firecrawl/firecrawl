import { beforeEach, expect, it, vi } from "vitest";
vi.mock("../../config", () => ({
  config: { FIRE_EXCHANGE_URL: "https://exchange.example" },
}));
const mockContract = vi.hoisted(() => vi.fn());
const mockForward = vi.hoisted(() => vi.fn());
vi.mock("../../lib/exchange-proxy", () => ({ forwardToExchange: mockForward }));
vi.mock("../../search/alexandria-source", () => ({
  loadToolContract: mockContract,
}));
import { discoverDomainTools, mergeDiscoveredTools } from "./tools";

let sequence = 0;
const input = (urls = ["https://spotify.com/"]) => ({
  data: { web: urls.map(url => ({ url, title: "", description: "" })) },
  teamId: `team-${sequence++}`,
  requestId: "request-1",
  hasExtendedCatalogAccess: true,
  timeoutMs: 1000,
  limit: 5,
});
const group = {
  id: "particle",
  matchedDomains: ["spotify.com"],
  domainCapabilities: { "spotify.com": ["podcasts/search"] },
};
const response = (body: unknown, status = 200) => ({ status, body });
beforeEach(() => {
  mockForward.mockReset().mockResolvedValue(response({ skills: [group] }));
  mockContract
    .mockReset()
    .mockImplementation(async ({ provider, capability }) => ({
      id: `${provider}/${capability}`,
      provider,
      capability,
      name: capability,
      description: "Find matching records",
      creditsCost: 3,
      perRecord: false,
      options: [],
      response: { about: "Records", key: "", fields: [] },
      examples: {},
    }));
});

it.each([false, true])(
  "forwards authenticated catalogue scope (%s) and only valid result URLs",
  async hasExtendedCatalogAccess => {
    const request = {
      ...input([
        "",
        "invalid",
        "https://user:secret@spotify.com/",
        "https://spotify.com/",
        "https://spotify.com/",
      ]),
      hasExtendedCatalogAccess,
    };
    request.data = {
      ...request.data,
      news: [{ url: "ftp://example.com" }],
      images: [{ url: "javascript:alert(1)" }],
    } as typeof request.data;
    const result = await discoverDomainTools(request);
    expect(mockForward).toHaveBeenCalledExactlyOnceWith({
      teamId: request.teamId,
      hasExtendedCatalogAccess,
      requestId: "request-1",
      method: "POST",
      path: "/v1/skills/resolve",
      body: { urls: ["https://spotify.com/"] },
      timeoutMs: expect.any(Number),
    });
    expect(result.items).toMatchObject([
      {
        provider: "particle",
        capability: "podcasts/search",
        matchedBy: ["domain"],
        matchedUrls: ["https://spotify.com/"],
      },
    ]);
    expect(result.items[0]).not.toHaveProperty("skills");
    expect(result.items[0]).not.toHaveProperty("url");
  },
);

it.each(
  [[], ["", "invalid"], ["https://" + "a".repeat(8192)]].map(urls => ({
    urls,
  })),
)("does no lookup without valid URLs (%#)", async ({ urls }) => {
  expect(await discoverDomainTools(input(urls))).toEqual({ items: [] });
  expect(mockForward).not.toHaveBeenCalled();
});
it("does no lookup after the deadline or without a result budget", async () => {
  await expect(
    discoverDomainTools({ ...input(), timeoutMs: 0 }),
  ).rejects.toThrow("deadline exceeded");
  expect(await discoverDomainTools({ ...input(), limit: 0 })).toEqual({
    items: [],
  });
  expect(mockForward).not.toHaveBeenCalled();
});
it.each([302, 503])(
  "does not disguise a failed lookup as no matches (%s)",
  async status => {
    mockForward.mockResolvedValue(response({}, status));
    await expect(discoverDomainTools(input())).rejects.toThrow("unavailable");
  },
);
it.each([
  {},
  { skills: [{ id: "particle" }] },
  { skills: [{ ...group, domainCapabilities: { "spotify.com": "invalid" } }] },
])("rejects malformed mappings (%j)", async body => {
  mockForward.mockResolvedValue(response(body));
  await expect(discoverDomainTools(input())).rejects.toThrow();
});
it("keeps an empty catalogue distinct from a failed lookup", async () => {
  mockForward.mockResolvedValue(response({ skills: [] }));
  expect(await discoverDomainTools(input())).toEqual({ items: [] });
  expect(mockContract).not.toHaveBeenCalled();
});
it("merges URL batches without leaking one domain's selection into another", async () => {
  const urls = Array.from(
    { length: 101 },
    (_, i) => `https://site${i}.example/`,
  );
  mockForward
    .mockResolvedValueOnce(
      response({
        skills: [
          {
            id: "particle",
            matchedDomains: ["site0.example"],
            domainCapabilities: { "site0.example": ["podcasts/search"] },
          },
        ],
      }),
    )
    .mockResolvedValueOnce(
      response({
        skills: [
          {
            id: "particle",
            matchedDomains: ["site100.example"],
            domainCapabilities: { "site100.example": ["podcasts/segment"] },
          },
        ],
      }),
    );
  const result = await discoverDomainTools(input(urls));
  expect(mockForward.mock.calls.map(([call]) => call.body)).toEqual([
    { urls: urls.slice(0, 100) },
    { urls: urls.slice(100) },
  ]);
  expect(result.items).toMatchObject([
    { capability: "podcasts/search", matchedUrls: [urls[0]] },
    { capability: "podcasts/segment", matchedUrls: [urls[100]] },
  ]);
});
it("preserves path-specific provenance and caches mappings by team and catalogue access", async () => {
  const urls = [
    "https://youtube.com/podcasts",
    "https://youtube.com/watch?v=123",
  ];
  const request = input(urls);
  mockForward.mockResolvedValue(
    response({
      skills: [
        {
          id: "particle",
          matchedDomains: ["youtube.com"],
          domainCapabilities: {
            [urls[0]]: ["podcasts/search"],
            "youtube.com": ["videos/search"],
          },
        },
      ],
    }),
  );
  const result = await discoverDomainTools(request);
  expect(result.items).toMatchObject([
    { capability: "podcasts/search", matchedUrls: [urls[0]] },
    { capability: "videos/search", matchedUrls: urls },
  ]);
  expect(await discoverDomainTools(request)).toEqual(result);
  expect(mockForward).toHaveBeenCalledOnce();
  expect(
    await discoverDomainTools({ ...request, teamId: "another-team" }),
  ).toEqual(result);
  expect(
    await discoverDomainTools({ ...request, hasExtendedCatalogAccess: false }),
  ).toEqual(result);
  expect(mockForward).toHaveBeenCalledTimes(3);
});
it("stops expanding provider-only matches once the requested limit is filled", async () => {
  mockForward
    .mockResolvedValueOnce(
      response({
        skills: [
          { id: "first", matchedDomains: ["spotify.com"] },
          { id: "second", matchedDomains: ["spotify.com"] },
        ],
      }),
    )
    .mockResolvedValue(
      response({
        success: true,
        creditsCost: 0,
        data: { items: [{ provider: "first", capability: "podcasts/search" }] },
      }),
    );
  const result = await discoverDomainTools({ ...input(), limit: 1 });
  expect(result.items).toMatchObject([
    { provider: "first", capability: "podcasts/search" },
  ]);
  expect(mockForward).toHaveBeenCalledTimes(2);
  expect(mockContract).toHaveBeenCalledOnce();
});
it("requests only the remaining number of tools when expanding a provider", async () => {
  mockForward
    .mockResolvedValueOnce(
      response({
        skills: [group, { id: "second", matchedDomains: ["spotify.com"] }],
      }),
    )
    .mockResolvedValueOnce(
      response({
        success: true,
        creditsCost: 0,
        data: {
          items: [{ provider: "second", capability: "podcasts/search" }],
        },
      }),
    );
  const result = await discoverDomainTools({ ...input(), limit: 2 });
  expect(result.items).toHaveLength(2);
  expect(mockForward.mock.calls[1][0].body.options).toEqual({
    providers: ["second"],
    level: "tools",
    limit: 1,
  });
});
it.each([
  { success: true, creditsCost: 1, data: { items: [] } },
  {
    success: true,
    creditsCost: 0,
    data: { items: [{ provider: "wrong", capability: "search" }] },
  },
])("rejects paid or wrong-provider catalogue responses (%j)", async body => {
  mockForward
    .mockResolvedValueOnce(
      response({
        skills: [{ id: "particle", matchedDomains: ["spotify.com"] }],
      }),
    )
    .mockResolvedValueOnce(response(body));
  const result = await discoverDomainTools(input());
  expect(result.items).toEqual([]);
  expect(result.warning).toBeDefined();
  expect(mockContract).not.toHaveBeenCalled();
});
it("keeps available contracts and warns when a contract cannot be loaded", async () => {
  mockForward.mockResolvedValue(
    response({
      skills: [
        {
          ...group,
          domainCapabilities: { "spotify.com": ["first", "broken", "third"] },
        },
      ],
    }),
  );
  const load = mockContract.getMockImplementation()!;
  mockContract.mockImplementation(async input => {
    if (input.capability === "broken") throw new Error("unavailable");
    return load(input);
  });
  const result = await discoverDomainTools(input());
  expect(result.items.map(tool => tool.capability)).toEqual(["first", "third"]);
  expect(result.warning).toBeDefined();
});
it("merges domain provenance into semantic matches without changing rank or mutating inputs", async () => {
  const {
    items: [domain],
  } = await discoverDomainTools(input());
  const semantic = {
    ...domain,
    name: "Semantic name",
    similarity: 0.9,
    matchedBy: ["semantic"] as const,
    matchedUrls: [],
  };
  const merged = mergeDiscoveredTools(
    [{ ...semantic, matchedBy: [...semantic.matchedBy] }],
    [domain],
  );
  expect(merged).toMatchObject([
    {
      name: "Semantic name",
      similarity: 0.9,
      matchedBy: ["semantic", "domain"],
      matchedUrls: ["https://spotify.com/"],
    },
  ]);
  expect(semantic.matchedUrls).toEqual([]);
  expect(domain.matchedBy).toEqual(["domain"]);
});
