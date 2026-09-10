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
      await resolveSearchSkills(data, "team", hasExtendedCatalogAccess),
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
