import request from "supertest";
import { randomUUID } from "node:crypto";
import { TEST_API_URL, scrapeTimeout } from "../lib";

// Both fixture teams must be on the adapter allowlist. The enabled fixture
// needs accepted provider terms and saved preferences; the disabled one must not.
const enabledKey = process.env.TEST_ENRICHMENT_ENABLED_API_KEY;
const disabledKey = process.env.TEST_ENRICHMENT_DISABLED_API_KEY;
const profileUrl = process.env.TEST_ENRICHMENT_PROFILE_URL;
const enabled = !!enabledKey && !!disabledKey && !!profileUrl;
const submit = (key: string, body: object) =>
  request(TEST_API_URL)
    .post("/v2/scrape")
    .set("Authorization", `Bearer ${key}`)
    .set("x-request-id", randomUUID())
    .send(body);

describe.skipIf(!enabled)("LinkedIn profile enrichment adapter", () => {
  it(
    "returns the configured provider's deterministic profile",
    async () => {
      const response = await submit(enabledKey!, {
        url: profileUrl,
        formats: ["json"],
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toMatchObject({
        success: true,
        data: {
          json: { name: expect.any(String) },
          enrichment: {
            source: { provider: expect.any(String) },
            creditsUsed: expect.any(Number),
            billingComplete: true,
          },
        },
      });
      expect(response.body.data.alexandria).toBeUndefined();
    },
    scrapeTimeout,
  );

  it(
    "links disabled teams to setup without executing providers",
    async () => {
      const response = await submit(disabledKey!, { url: profileUrl });
      expect(response.statusCode).toBe(403);
      expect(response.body).toMatchObject({
        success: false,
        code: "ENRICHMENT_SETUP_REQUIRED",
        details: {
          creditsUsed: 0,
          billingComplete: true,
          action: { url: expect.stringContaining("enrichment%3Dtrue") },
        },
      });
    },
    scrapeTimeout,
  );

  it(
    "rejects browser formats before calling enrichment",
    async () => {
      const response = await submit(enabledKey!, {
        url: profileUrl,
        formats: ["html"],
      });
      expect(response.statusCode).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain("plain json or markdown");
    },
    scrapeTimeout,
  );
});
