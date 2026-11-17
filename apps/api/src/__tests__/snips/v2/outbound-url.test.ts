import { config } from "../../../config";
import { idmux, Identity, scrape, scrapeTimeout, TEST_API_URL } from "./lib";
import request from "./lib";

if (
  process.env.OUTBOUND_SECURITY_TEST_REQUIRED === "true" &&
  config.ALLOW_LOCAL_WEBHOOKS === true
) {
  throw new Error("Outbound security snips require ALLOW_LOCAL_WEBHOOKS=false");
}

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

    it(
      "rejects DNS-resolved loopback before dispatching to an engine",
      async () => {
        for (const version of ["v1", "v2"]) {
          const response = await request(TEST_API_URL)
            .post(`/${version}/scrape`)
            .set("Authorization", `Bearer ${identity.apiKey}`)
            .send({ url: "http://localtest.me" });
          expect(response.statusCode).toBe(403);
          expect(response.body.code).toBe("SCRAPE_UNSAFE_DESTINATION");
          expect(response.body.success).toBe(false);
        }
      },
      scrapeTimeout,
    );
  },
);
