import { config } from "../../../config";
import { describeIf, TEST_API_URL, TEST_PRODUCTION } from "../lib";
import request from "supertest";

const CANONICAL_PRM_URL =
  "https://www.firecrawl.dev/.well-known/oauth-protected-resource";

const EXPECTED_WWW_AUTHENTICATE = `Bearer resource_metadata="${CANONICAL_PRM_URL}"`;

describeIf(TEST_PRODUCTION)("Agent auth discovery (WWW-Authenticate)", () => {
  beforeAll(() => {
    config.USE_DB_AUTHENTICATION = true;
  });

  afterAll(() => {
    delete config.USE_DB_AUTHENTICATION;
  });

  it("defaults AGENT_AUTH_RESOURCE_METADATA_URL to canonical PRM", () => {
    expect(config.AGENT_AUTH_RESOURCE_METADATA_URL).toBe(CANONICAL_PRM_URL);
  });

  it.concurrent(
    "returns WWW-Authenticate on 401 without Authorization",
    async () => {
      const response = await request(TEST_API_URL)
        .post("/v2/scrape")
        .set("Content-Type", "application/json")
        .send({ url: "https://example.com" });

      expect(response.statusCode).toBe(401);
      expect(response.headers["www-authenticate"]).toBe(
        EXPECTED_WWW_AUTHENTICATE,
      );
    },
  );

  it.concurrent(
    "returns WWW-Authenticate on 401 with invalid API key",
    async () => {
      const response = await request(TEST_API_URL)
        .post("/v2/scrape")
        .set("Authorization", "Bearer invalid-api-key")
        .set("Content-Type", "application/json")
        .send({ url: "https://example.com" });

      expect(response.statusCode).toBe(401);
      expect(response.headers["www-authenticate"]).toBe(
        EXPECTED_WWW_AUTHENTICATE,
      );
    },
  );

  it.concurrent(
    "does not return WWW-Authenticate on successful auth",
    async () => {
      const response = await request(TEST_API_URL)
        .post("/v2/scrape")
        .set("Authorization", `Bearer ${config.TEST_API_KEY}`)
        .set("Content-Type", "application/json")
        .send({ url: "https://example.com" });

      expect(response.statusCode).toBe(200);
      expect(response.headers["www-authenticate"]).toBeUndefined();
    },
  );
});
