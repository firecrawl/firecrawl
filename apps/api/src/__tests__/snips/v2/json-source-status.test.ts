import {
  ALLOW_TEST_SUITE_WEBSITE,
  describeIf,
  HAS_AI,
  TEST_PRODUCTION,
  TEST_SUITE_WEBSITE,
} from "../lib";
import { scrape, scrapeTimeout, idmux, Identity } from "./lib";

describeIf(ALLOW_TEST_SUITE_WEBSITE && (TEST_PRODUCTION || HAS_AI))(
  "JSON extraction source status",
  () => {
    let identity: Identity;
    beforeAll(async () => {
      identity = await idmux({
        name: "json-source-status",
        concurrency: 2,
        credits: 100,
      });
    }, 10000 + scrapeTimeout);

    it(
      "keeps JSON extraction available for a successful source",
      async () => {
        const result = await scrape(
          {
            url: TEST_SUITE_WEBSITE,
            maxAge: 0,
            formats: [
              {
                type: "json",
                prompt: "Extract the main heading from the page.",
                schema: {
                  type: "object",
                  properties: { heading: { type: "string" } },
                  required: ["heading"],
                },
              },
            ],
          },
          identity,
        );
        expect(result.metadata.statusCode).toBe(200);
        expect(typeof result.json?.heading).toBe("string");
        expect(result.json.heading.length).toBeGreaterThan(0);
      },
      scrapeTimeout,
    );

    it(
      "returns null JSON and a warning for an absent source",
      async () => {
        const result = await scrape(
          {
            url: `${TEST_SUITE_WEBSITE}/missing-release-fixture-5717`,
            maxAge: 0,
            formats: [
              { type: "markdown" },
              {
                type: "json",
                prompt:
                  "Extract the release version from this page. Do not infer a version.",
                schema: {
                  type: "object",
                  properties: { version: { type: "string" } },
                },
              },
            ],
          },
          identity,
        );
        expect(result.metadata.statusCode).toBe(404);
        expect(result.json).toBeNull();
        expect(result.warning).toContain("source returned HTTP 404");
        expect(typeof result.markdown).toBe("string");
      },
      scrapeTimeout,
    );
  },
);
