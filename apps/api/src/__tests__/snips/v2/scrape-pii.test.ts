import {
  ALLOW_TEST_SUITE_WEBSITE,
  describeIf,
  TEST_SUITE_WEBSITE,
} from "../lib";
import { Identity, idmux, scrapeRaw, scrapeTimeout } from "./lib";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "v2-scrape-pii",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000 + scrapeTimeout);

describeIf(ALLOW_TEST_SUITE_WEBSITE)("V2 Scrape redactPII (schema)", () => {
  it.concurrent(
    "accepts redactPII: true with markdown output",
    async () => {
      const res = await scrapeRaw(
        {
          url: TEST_SUITE_WEBSITE,
          formats: ["markdown"],
          redactPII: true,
        },
        identity,
      );

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.pii).toBeUndefined();
    },
    scrapeTimeout,
  );

  it.concurrent(
    "rejects redactPII with non-boolean value",
    async () => {
      const res = await scrapeRaw(
        {
          url: TEST_SUITE_WEBSITE,
          formats: ["markdown"],
          // typed as boolean, but we want to confirm the API rejects strings.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          redactPII: "yes" as any,
        },
        identity,
      );

      expect(res.statusCode).toBe(400);
      expect(res.body.success).toBe(false);
    },
    scrapeTimeout,
  );

  it.concurrent(
    "accepts redactPII as an options object with mode/entities/replaceStyle",
    async () => {
      const res = await scrapeRaw(
        {
          url: TEST_SUITE_WEBSITE,
          formats: ["markdown"],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          redactPII: {
            mode: "accurate",
            entities: ["EMAIL", "PHONE"],
            replaceStyle: "tag",
          } as any,
        },
        identity,
      );

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.pii).toBeUndefined();
    },
    scrapeTimeout,
  );

  it.concurrent(
    "rejects an unknown mode value",
    async () => {
      const res = await scrapeRaw(
        {
          url: TEST_SUITE_WEBSITE,
          formats: ["markdown"],
          // "model" is the fire-privacy internal mode, not the
          // public surface — must be rejected.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          redactPII: { mode: "model" } as any,
        },
        identity,
      );

      expect(res.statusCode).toBe(400);
      expect(res.body.success).toBe(false);
    },
    scrapeTimeout,
  );
});
