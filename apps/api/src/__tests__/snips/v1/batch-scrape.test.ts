import { batchScrape, scrapeTimeout, idmux, Identity } from "./lib";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "batch-scrape",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000);

describe("Batch scrape tests", () => {
    it.concurrent("works", async () => {
        const response = await batchScrape({
            urls: ["http://firecrawl.dev"]
        }, identity);
        
        expect(response.data[0]).toHaveProperty("markdown");
        expect(response.data[0].markdown).toContain("Firecrawl");
    }, scrapeTimeout);

    if (!process.env.TEST_SUITE_SELF_HOSTED) {
        describe("JSON format", () => {
            it.concurrent("works", async () => {
                const response = await batchScrape({
                    urls: ["http://firecrawl.dev"],
                    formats: ["json"],
                    jsonOptions: {
                        prompt: "Based on the information on the page, find what the company's mission is and whether it supports SSO, and whether it is open source.",
                        schema: {
                            type: "object",
                            properties: {
                                company_mission: {
                                    type: "string",
                                },
                                supports_sso: {
                                    type: "boolean",
                                },
                                is_open_source: {
                                    type: "boolean",
                                },
                            },
                            required: ["company_mission", "supports_sso", "is_open_source"],
                        },
                    },
                }, identity);
            
                expect(response.data[0]).toHaveProperty("json");
                expect(response.data[0].json).toHaveProperty("company_mission");
                expect(typeof response.data[0].json.company_mission).toBe("string");
                expect(response.data[0].json).toHaveProperty("supports_sso");
                expect(response.data[0].json.supports_sso).toBe(false);
                expect(typeof response.data[0].json.supports_sso).toBe("boolean");
                expect(response.data[0].json).toHaveProperty("is_open_source");
                expect(response.data[0].json.is_open_source).toBe(true);
                expect(typeof response.data[0].json.is_open_source).toBe("boolean");
            }, 180000);
        });
    }

    it.concurrent("sourceURL stays unnormalized", async () => {
        const response = await batchScrape({
            urls: ["https://firecrawl.dev/?pagewanted=all&et_blog"],
        }, identity);
    
        expect(response.data[0].metadata.sourceURL).toBe("https://firecrawl.dev/?pagewanted=all&et_blog");
    }, scrapeTimeout);
});
