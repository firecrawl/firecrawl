import request, { TEST_API_URL, idmux, Identity } from "./lib";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "express5",
    concurrency: 10,
    credits: 100,
  });
});

describe("Express 5 compatibility", () => {
  it("serves root JSON through the Express app", async () => {
    const response = await request(TEST_API_URL).get("/");

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      message: "Firecrawl API",
      documentation_url: "https://docs.firecrawl.dev",
    });
  });

  it("returns the API bad JSON envelope for malformed JSON bodies", async () => {
    const response = await request(TEST_API_URL)
      .post("/v2/scrape")
      .set("Content-Type", "application/json")
      .send("{");

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      success: false,
      code: "BAD_REQUEST_INVALID_JSON",
      error: "Bad request, malformed JSON",
    });
  });

  it("still captures route params before validation middleware", async () => {
    const response = await request(TEST_API_URL)
      .get("/v2/crawl/not-a-uuid")
      .set("Authorization", `Bearer ${identity.apiKey}`);

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      success: false,
      error: "Invalid job ID format. Job ID must be a valid UUID.",
    });
  });
});
