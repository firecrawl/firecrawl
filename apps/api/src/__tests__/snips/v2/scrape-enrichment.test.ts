import request from "supertest";
import { TEST_API_URL, scrapeTimeout } from "../lib";

// Use a fixture team for which direct LinkedIn scraping is blocked.
const apiKey = process.env.TEST_LINKEDIN_BLOCKED_API_KEY;
const submit = (url: string) =>
  request(TEST_API_URL)
    .post("/v2/scrape")
    .set("Authorization", `Bearer ${apiKey}`)
    .send({ url });

describe.skipIf(!apiKey)("LinkedIn enrichment setup guidance", () => {
  it.each([
    "https://ca.linkedin.com/in/example",
    "https://linkedin.com/company/example",
  ])(
    "adds setup guidance to a blocked supported profile: %s",
    async url => {
      const response = await submit(url);
      expect(response.statusCode).toBe(403);
      expect(response.body).toMatchObject({
        success: false,
        code: "UNSUPPORTED_SITE",
        details: {
          action: { url: expect.stringContaining("enrichment%3Dtrue") },
        },
      });
      expect(response.body.error).toContain(response.body.details.action.url);
    },
    scrapeTimeout,
  );

  it(
    "keeps unsupported LinkedIn paths on the existing error",
    async () => {
      const response = await submit("https://linkedin.com/jobs/123");
      expect(response.statusCode).toBe(403);
      expect(response.body.code).toBe("UNSUPPORTED_SITE");
      expect(response.body.details?.action).toBeUndefined();
    },
    scrapeTimeout,
  );
});
