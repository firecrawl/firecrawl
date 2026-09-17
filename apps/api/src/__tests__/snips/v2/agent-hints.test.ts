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
