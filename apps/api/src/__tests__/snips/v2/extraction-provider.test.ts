import {
  scrape,
  scrapeWithFailure,
  scrapeTimeout,
  idmux,
  Identity,
} from "./lib";

// Runs only where the API under test is guaranteed to route to the provider:
// a configured base URL and either a 100% rollout or the per-request opt-in.
const configured =
  !!process.env.EXTRACTION_PROVIDER_BASE_URL &&
  (process.env.EXTRACTION_PROVIDER_ROLLOUT_PERCENT === "100" ||
    ["true", "1"].includes(
      (process.env.EXTRACTION_PROVIDER_REQUEST_OPT_IN ?? "").toLowerCase(),
    ));

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "extraction-provider",
    concurrency: 10,
    credits: 1_000_000,
  });
}, 10000);

(configured ? describe : describe.skip)(
  "JSON extraction via the extraction provider",
  () => {
    it.concurrent(
      "returns a schema-conforming object",
      async () => {
        const response = await scrape(
          {
            url: "https://firecrawl.dev",
            formats: [
              {
                type: "json",
                schema: {
                  type: "object",
                  properties: {
                    company_name: { type: "string" },
                    tagline: { type: "string" },
                  },
                  required: ["company_name", "tagline"],
                },
              },
            ],
          },
          identity,
        );
        expect(response.json).toBeDefined();
        expect(typeof response.json.company_name).toBe("string");
        expect(typeof response.json.tagline).toBe("string");
        expect(response.json.company_name.toLowerCase()).toContain("firecrawl");
      },
      scrapeTimeout,
    );
  },
);

describe("JSON format model option", () => {
  it.concurrent(
    "rejects a model that is not available",
    async () => {
      const response = await scrapeWithFailure(
        {
          url: "https://firecrawl.dev",
          formats: [
            {
              type: "json",
              model: "not-a-configured-extraction-model",
              schema: { type: "object", properties: { x: { type: "string" } } },
            },
          ],
        },
        identity,
      );
      expect(response.error).toContain("Unsupported extraction model");
    },
    scrapeTimeout,
  );
});
