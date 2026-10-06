import crypto from "crypto";
import { config } from "../../../config";
import {
  ALLOW_TEST_SUITE_WEBSITE,
  HAS_FIRE_ENGINE,
  TEST_PRODUCTION,
  TEST_SELF_HOST,
  TEST_SUITE_WEBSITE,
  itIf,
} from "../lib";
import {
  Identity,
  idmux,
  browserCreateRaw,
  browserDeleteRaw,
  browserExecuteRaw,
  scrapeInteractRaw,
  scrapeRaw,
  scrapeStopInteractiveBrowserRaw,
  scrapeTimeout,
} from "./lib";

// Plain block rules (not redirects to stubs): an ad server from Peter Lowe's
// list and a generic EasyList Cookie Notices pattern.
const BLOCKING_PROBE = `
  const outcome = url => page.evaluate(
    target => fetch(target, { mode: "no-cors", cache: "no-store" }).then(() => "loaded", () => "blocked"),
    url,
  );
  console.log("ads:" + await outcome("https://ads.pubmatic.com/AdServer/js/pwt.js"));
  console.log("cookies:" + await outcome(new URL("/static/site-cookie-banner.js", page.url()).href));
`;

describe("Browser ad blocking", () => {
  let identity: Identity;

  beforeAll(async () => {
    identity = await idmux({
      name: "browser-block-ads",
      concurrency: 20,
      credits: 1_000_000,
    });
  }, 10000 + scrapeTimeout);

  const canRunBrowser =
    !TEST_SELF_HOST && ALLOW_TEST_SUITE_WEBSITE && !!config.HANGAR_URL;

  itIf(canRunBrowser).each([
    [undefined, "blocked"],
    [true, "blocked"],
    [false, "loaded"],
  ] as const)(
    "applies blockAds=%s to browser sessions",
    async (blockAds, expected) => {
      let sessionId: string | null = null;
      try {
        const created = await browserCreateRaw(
          { ttl: 120, activityTtl: 120, blockAds },
          identity,
        );
        expect(created.statusCode).toBe(200);
        sessionId = created.body.id as string;

        const executed = await browserExecuteRaw(
          sessionId,
          {
            language: "node",
            timeout: 60,
            code: `await page.goto(${JSON.stringify(TEST_SUITE_WEBSITE)});\n${BLOCKING_PROBE}`,
          },
          identity,
        );
        expect(executed.statusCode).toBe(200);
        expect(executed.body.stdout).toContain(`ads:${expected}`);
        expect(executed.body.stdout).toContain(`cookies:${expected}`);
      } finally {
        if (sessionId) await browserDeleteRaw(sessionId, identity);
      }
    },
    scrapeTimeout,
  );

  itIf(canRunBrowser && (TEST_PRODUCTION || HAS_FIRE_ENGINE))(
    "inherits blockAds=false from the scrape in interact sessions",
    async () => {
      let scrapeId: string | null = null;
      try {
        const scraped = await scrapeRaw(
          {
            url: `${TEST_SUITE_WEBSITE}?testId=${crypto.randomUUID()}`,
            blockAds: false,
          },
          identity,
        );
        expect(scraped.statusCode).toBe(200);
        scrapeId = scraped.body.scrape_id as string;

        const executed = await scrapeInteractRaw(
          scrapeId,
          { language: "node", timeout: 60, code: BLOCKING_PROBE },
          identity,
        );
        expect(executed.statusCode).toBe(200);
        expect(executed.body.stdout).toContain("ads:loaded");
        expect(executed.body.stdout).toContain("cookies:loaded");
      } finally {
        if (scrapeId) await scrapeStopInteractiveBrowserRaw(scrapeId, identity);
      }
    },
    scrapeTimeout,
  );

  itIf(!!config.HANGAR_URL)("rejects a non-boolean blockAds", async () => {
    const created = await browserCreateRaw(
      { blockAds: "no" as unknown as boolean },
      identity,
    );
    expect(created.statusCode).toBe(400);
    expect(created.body.success).toBe(false);
  });
});
