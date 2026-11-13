import request from "supertest";
import {
  ALLOW_TEST_SUITE_WEBSITE,
  HAS_AI,
  itIf,
  TEST_API_URL,
  TEST_PRODUCTION,
  TEST_SUITE_WEBSITE,
} from "../lib";
import {
  describeExtract,
  EXTRACT_LIVE,
  EXTRACT_SUNSET,
  extract,
  idmux,
  Identity,
} from "./lib";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "extract",
    concurrency: 100,
    tokens: 1000000,
  });
}, 10000);

describeExtract(TEST_PRODUCTION || (HAS_AI && ALLOW_TEST_SUITE_WEBSITE))(
  "Extract tests",
  () => {
    it.concurrent(
      "works",
      async () => {
        const res = await extract(
          {
            urls: [TEST_SUITE_WEBSITE],
            schema: {
              type: "object",
              properties: {
                company_mission: {
                  type: "string",
                },
                is_open_source: {
                  type: "boolean",
                },
              },
              required: ["company_mission", "is_open_source"],
            },
            scrapeOptions: {
              timeout: 75000,
            },
            origin: "api-sdk",
          },
          identity,
        );

        expect(res.data).toHaveProperty("company_mission");
        expect(typeof res.data.company_mission).toBe("string");
        expect(res.data).toHaveProperty("is_open_source");
        expect(typeof res.data.is_open_source).toBe("boolean");
        expect(res.data.is_open_source).toBe(true);
      },
      90000,
    );

    it.concurrent(
      "works with unsupported JSON schema parameters",
      async () => {
        const res = await extract(
          {
            urls: [TEST_SUITE_WEBSITE],
            schema: {
              type: "object",
              properties: {
                company_name: {
                  type: "string",
                  pattern: "^[a-zA-Z0-9]+$",
                },
              },
              required: ["company_name"],
            },
            scrapeOptions: {
              timeout: 75000,
            },
            origin: "api-sdk",
          },
          identity,
        );

        expect(res.data).toHaveProperty("company_name");
        expect(typeof res.data.company_name).toBe("string");
      },
      90000,
    );
  },
);

itIf(!EXTRACT_LIVE)(
  "POST /v1/extract answers 410 after the extract sunset",
  async () => {
    const res = await request(TEST_API_URL)
      .post("/v1/extract")
      .set("Authorization", `Bearer ${identity.apiKey}`)
      .set("Content-Type", "application/json")
      .send({ urls: [TEST_SUITE_WEBSITE], prompt: "Extract the page title." });

    expect(res.statusCode).toBe(410);
    expect(res.body.code).toBe("ENDPOINT_REMOVED");
    expect(res.body.replacement).toBe("/v2/scrape");
    expect(res.body.documentation_url).toBe(
      "https://docs.firecrawl.dev/migrating-from-extract",
    );
    expect(res.headers["sunset"]).toBe(new Date(EXTRACT_SUNSET).toUTCString());
  },
  30000,
);
