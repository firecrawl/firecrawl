import { Identity, idmux, scrapeTimeout, scrapeRaw } from "./lib";
import {
  ALLOW_TEST_SUITE_WEBSITE,
  describeIf,
  HAS_AI,
  TEST_PRODUCTION,
  TEST_SUITE_WEBSITE,
} from "../lib";

describeIf(TEST_PRODUCTION || (HAS_AI && ALLOW_TEST_SUITE_WEBSITE))(
  "V2 System Prompt Rejection",
  () => {
    let identity: Identity;

    beforeAll(async () => {
      identity = await idmux({
        name: "v2-system-prompt-rejection",
        concurrency: 100,
        credits: 1000000,
      });
    });

    it(
      "should reject systemPrompt in json format options for v2 scrape",
      async () => {
        const response = await scrapeRaw(
          {
            url: TEST_SUITE_WEBSITE,
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
        expect(response.body.error).not.toBe("Bad Request");
        expect(response.body.error).toContain("systemPrompt");
      },
      scrapeTimeout,
    );

    it(
      "should accept valid json format options without systemPrompt",
      async () => {
        const response = await scrapeRaw(
          {
            url: TEST_SUITE_WEBSITE,
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
      },
      scrapeTimeout + 30000,
    );
  },
);
