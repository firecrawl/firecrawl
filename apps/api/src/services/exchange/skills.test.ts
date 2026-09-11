import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
vi.mock("../../config", () => ({
  config: { FIRE_EXCHANGE_URL: "https://exchange.example" },
}));
import { resolveSearchSkills } from "./skills";
const original = getGlobalDispatcher();
let agent: MockAgent;
beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});
afterEach(async () => {
  setGlobalDispatcher(original);
  await agent.close();
});
it.each([false, true])(
  "forwards extended catalogue access %s with skill lookup",
  async hasExtendedCatalogAccess => {
    agent
      .get("https://exchange.example")
      .intercept({
        path: "/v1/skills/resolve",
        method: "POST",
        body: JSON.stringify({ urls: ["https://spotify.com/"] }),
        headers: {
          "x-exchange-team-id": "team",
          "x-request-id": "agent-request",
          "x-exchange-extended-catalog-access": String(
            hasExtendedCatalogAccess,
          ),
        },
      })
      .reply(200, {
        skills: [
          {
            id: "particle",
            description: "Podcasts",
            matchedDomains: ["spotify.com"],
            url: "/v1/skills/particle/SKILL.md",
          },
        ],
      });
    const data = {
      web: [
        { url: "" },
        { url: "not a URL" },
        { url: "https://" },
        { url: "https://spotify.com/" },
        { url: "https://spotify.com/" },
      ],
      news: [{ url: "ftp://example.com/" }],
      images: [{ url: "javascript:alert(1)" }],
    } as Parameters<typeof resolveSearchSkills>[0];
    expect(
      await resolveSearchSkills(
        data,
        "team",
        hasExtendedCatalogAccess,
        "agent-request",
      ),
    ).toEqual([
      {
        id: "particle",
        description: "Podcasts",
        matchedDomains: ["spotify.com"],
        url: "https://api.firecrawl.dev/exchange/skills/particle/SKILL.md",
      },
    ]);
    agent.assertNoPendingInterceptors();
  },
);
it.each([{}, { web: [{ url: "" }, { url: "invalid" }] }])(
  "does not make a request without valid URLs: %j",
  async data => {
    expect(
      await resolveSearchSkills(
        data as Parameters<typeof resolveSearchSkills>[0],
        "team",
      ),
    ).toEqual([]);
  },
);
it("rejects unsuccessful lookups instead of reporting no matches", async () => {
  agent
    .get("https://exchange.example")
    .intercept({ path: "/v1/skills/resolve", method: "POST" })
    .reply(503, {});
  await expect(
    resolveSearchSkills(
      { web: [{ url: "https://spotify.com/" }] } as Parameters<
        typeof resolveSearchSkills
      >[0],
      "team",
    ),
  ).rejects.toThrow("Skills unavailable");
});

it("resolves a query without URLs and preserves grouped provider metadata", async () => {
  agent
    .get("https://exchange.example")
    .intercept({
      path: "/v1/skills/resolve",
      method: "POST",
      body: JSON.stringify({ urls: [], query: "Spotify interviews" }),
    })
    .reply(200, {
      skills: [
        {
          id: "particle",
          name: "Particle",
          origin: "api",
          toolCount: 13,
          description: "Podcast intelligence",
          matchedDomains: [],
          matchedTerms: ["Spotify"],
          url: "/v1/skills/particle/SKILL.md",
        },
      ],
    });
  expect(
    await resolveSearchSkills(
      {},
      "team",
      false,
      "request",
      "Spotify interviews",
    ),
  ).toEqual([
    {
      id: "particle",
      name: "Particle",
      origin: "api",
      toolCount: 13,
      description: "Podcast intelligence",
      matchedDomains: [],
      matchedTerms: ["Spotify"],
      url: "https://api.firecrawl.dev/exchange/skills/particle/SKILL.md",
    },
  ]);
  agent.assertNoPendingInterceptors();
});

it("merges selected tools across URL batches without leaking one domain's selection into another", async () => {
  const urls = Array.from(
    { length: 101 },
    (_, index) => `https://site${index}.example/`,
  );
  const selections = ["podcasts/search", "podcasts/segment"];
  for (const [index, batch] of [
    urls.slice(0, 100),
    urls.slice(100),
  ].entries()) {
    const domain = new URL(batch[0]).hostname;
    agent
      .get("https://exchange.example")
      .intercept({
        path: "/v1/skills/resolve",
        method: "POST",
        body: JSON.stringify({ urls: batch, query: "Spotify" }),
      })
      .reply(200, {
        skills: [
          {
            id: "particle",
            ...(index === 0 ? { name: "Particle", origin: "api" } : {}),
            description: "Podcasts",
            toolCount: 2,
            matchedDomains: [domain],
            matchedTerms: ["Spotify"],
            domainCapabilities: { [domain]: [selections[index]] },
            queryCapabilities: ["podcasts/episodes/search"],
            url: "/v1/skills/particle/SKILL.md",
          },
        ],
      });
  }
  const skills = await resolveSearchSkills(
    { web: urls.map(url => ({ url })) } as Parameters<
      typeof resolveSearchSkills
    >[0],
    "team",
    false,
    "request",
    "Spotify",
  );
  expect(skills).toMatchObject([
    {
      id: "particle",
      toolCount: 3,
      name: "Particle",
      origin: "api",
      matchedTerms: ["Spotify"],
      matchedDomains: ["site0.example", "site100.example"],
      domainCapabilities: {
        "site0.example": ["podcasts/search"],
        "site100.example": ["podcasts/segment"],
      },
      queryCapabilities: ["podcasts/episodes/search"],
    },
  ]);
  agent.assertNoPendingInterceptors();
});

it("returns contract links on the caller's API origin", async () => {
  agent
    .get("https://exchange.example")
    .intercept({ path: "/v1/skills/resolve", method: "POST" })
    .reply(200, {
      skills: [
        {
          id: "particle",
          description: "Podcasts",
          matchedDomains: ["spotify.com"],
          url: "/v1/skills/particle/SKILL.md",
        },
      ],
    });
  const result = await resolveSearchSkills(
    { web: [{ url: "https://spotify.com" }] } as Parameters<
      typeof resolveSearchSkills
    >[0],
    "team",
    true,
    undefined,
    undefined,
    "https://preview.firecrawl.dev",
  );
  expect(result[0].url).toBe(
    "https://preview.firecrawl.dev/exchange/skills/particle/SKILL.md",
  );
});
