import { Identity, idmux, scrapeTimeout, scrapeRaw } from "./lib";
import { ScrapeRequestInput } from "../../../controllers/v2/types";

describe("V2 System Prompt Rejection", () => {
  if (!process.env.TEST_SUITE_SELF_HOSTED || process.env.OPENAI_API_KEY || process.env.OLLAMA_BASE_URL) {
    let identity: Identity;
    
    beforeAll(async () => {
      identity = await idmux({
        name: "v2-system-prompt-rejection",
        concurrency: 100,
        credits: 1000000,
      });
    });

    it("should reject systemPrompt in json format options for v2 scrape", async () => {
      const response = await scrapeRaw(
        {
          url: "https://firecrawl.dev",
          formats: [
            {
              type: "json",
              schema: {
                type: "object",
                properties: { title: { type: "string" } },
              },
              systemPrompt: "Custom system prompt that should be rejected",
            },
          ],
        } as any,
        identity,
      );

      expect(response.statusCode).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Bad Request");
    }, scrapeTimeout);

    it("should accept valid json format options without systemPrompt", async () => {
      const response = await scrapeRaw(
        {
          url: "https://firecrawl.dev",
          formats: [
            {
              type: "json",
              schema: {
                type: "object",
                properties: { title: { type: "string" } },
              },
              prompt: "Extract the title",
            },
          ],
        },
        identity,
      );

      expect(response.statusCode).toBe(200);
      expect(response.body.success).toBe(true);
    }, scrapeTimeout + 30000);
  } else {
    it("mocked", () => {
      expect(true).toBe(true);
    });
  }
});
