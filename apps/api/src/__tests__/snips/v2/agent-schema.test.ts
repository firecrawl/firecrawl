import request from "supertest";
import { Identity, idmux, scrapeTimeout, TEST_API_URL } from "../lib";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({ name: "agent-schema", credits: 1000000 });
}, scrapeTimeout);

describe("Agent schema intake", () => {
  it.each([
    ["zero", 0],
    ["empty string", ""],
    ["async schema", { $async: true, type: "object" }],
    ["OpenAPI example", { type: "string", example: "a" }],
    ["unknown format", { type: "string", format: "phone" }],
    ["vendor keyword", { type: "object", propertyOrdering: ["name"] }],
    [
      "schema wrapper",
      { name: "result", strict: true, schema: { type: "object" } },
    ],
  ])(
    "returns an actionable 400 for %s",
    async (_, schema) => {
      const response = await request(TEST_API_URL)
        .post("/v2/agent")
        .set("Authorization", `Bearer ${identity.apiKey}`)
        .send({ prompt: "Find the details", schema });

      expect(response.statusCode).toBe(400);
      expect(response.body).toMatchObject({
        success: false,
        code: "BAD_REQUEST",
        error: expect.stringContaining("Invalid JSON schema:"),
      });
    },
    scrapeTimeout,
  );
});
