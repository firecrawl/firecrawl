import { describeIf, TEST_PRODUCTION, TEST_SUITE_WEBSITE } from "../lib";
import request, { idmux, Identity, scrapeTimeout, TEST_API_URL } from "./lib";

let identity: Identity;
beforeAll(async () => {
  identity = await idmux({
    name: "agent-hints",
    concurrency: 10,
    credits: 1000,
  });
}, 20000);

describeIf(TEST_PRODUCTION)("Agent hints", () => {
  const missingPage = `${TEST_SUITE_WEBSITE}/agent-hints-not-found`;

  it(
    "adds a scrape-to-search hint for a missing source page",
    async () => {
      const response = await request(TEST_API_URL)
        .post("/v2/scrape")
        .set("Authorization", `Bearer ${identity.apiKey}`)
        .set("X-Firecrawl-Agent-Hints", "true")
        .send({ url: missingPage, timeout: scrapeTimeout });
      expect(response.statusCode).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.metadata.statusCode).toBe(404);
      expect(response.body.agent_hints).toEqual([
        expect.stringContaining("POST /v2/search"),
      ]);
    },
    scrapeTimeout + 10000,
  );

  it(
    "keeps hints off when the opt-in header is false despite a hint condition",
    async () => {
      const response = await request(TEST_API_URL)
        .post("/v2/scrape")
        .set("Authorization", `Bearer ${identity.apiKey}`)
        .set("X-Firecrawl-Agent-Hints", "false")
        .send({ url: missingPage, timeout: scrapeTimeout });
      expect(response.statusCode).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.metadata.statusCode).toBe(404);
      expect(response.body).not.toHaveProperty("agent_hints");
    },
    scrapeTimeout + 10000,
  );

  it(
    "does not add static feedback guidance to a completed scrape",
    async () => {
      const response = await request(TEST_API_URL)
        .post("/v2/scrape")
        .set("Authorization", `Bearer ${identity.apiKey}`)
        .set("X-Firecrawl-Agent-Hints", "true")
        .send({ url: TEST_SUITE_WEBSITE, timeout: scrapeTimeout });
      expect(response.statusCode).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body).not.toHaveProperty("agent_hints");
    },
    scrapeTimeout + 10000,
  );

  it(
    "leaves hints off by default on a completed map",
    async () => {
      const response = await request(TEST_API_URL)
        .post("/v2/map")
        .set("Authorization", `Bearer ${identity.apiKey}`)
        .send({ url: TEST_SUITE_WEBSITE, limit: 1, timeout: scrapeTimeout });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toHaveProperty("agent_hints");
    },
    scrapeTimeout + 10000,
  );

  it("preserves validation errors without inventing hints", async () => {
    const response = await request(TEST_API_URL)
      .post("/v2/scrape")
      .set("Authorization", `Bearer ${identity.apiKey}`)
      .set("X-Firecrawl-Agent-Hints", "true")
      .send({ url: "not-a-url" });
    expect(response.statusCode).toBe(400);
    expect(response.body.success).toBe(false);
    expect(typeof response.body.error).toBe("string");
    expect(response.body).not.toHaveProperty("agent_hints");
  });
});
