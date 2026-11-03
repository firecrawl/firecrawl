import { config } from "../../../config";
import { idmux, Identity, scrape, scrapeTimeout, TEST_API_URL } from "./lib";
import request from "./lib";

// The local-network override deliberately changes the expected policy.
describe.skipIf(config.ALLOW_LOCAL_WEBHOOKS === true)(
  "outbound URL validation",
  () => {
    let identity: Identity;
    beforeAll(async () => {
      identity = await idmux({
        name: "outbound-url",
        concurrency: 10,
        credits: 1000,
      });
    });

    it(
      "allows a public scrape",
      async () => {
        const document = await scrape(
          { url: "https://example.com", formats: ["markdown"] },
          identity,
        );
        expect(document.markdown).toContain("Example Domain");
      },
      scrapeTimeout,
    );

    it.each([
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.1",
      "http://2130706433",
      "http://[::1]",
    ])(
      "rejects %s before scrape or webhook handoff",
      async url => {
        for (const version of ["v1", "v2"]) {
          for (const [endpoint, body] of [
            ["scrape", { url }],
            ["crawl", { url: "https://example.com", webhook: { url } }],
          ] as const) {
            const response = await request(TEST_API_URL)
              .post(`/${version}/${endpoint}`)
              .set("Authorization", `Bearer ${identity.apiKey}`)
              .send(body);
            expect(response.statusCode).toBe(400);
            expect(response.body.success).toBe(false);
          }
        }
      },
      scrapeTimeout,
    );
  },
);
