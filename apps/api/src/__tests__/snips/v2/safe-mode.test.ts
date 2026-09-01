import {
  ALLOW_TEST_SUITE_WEBSITE,
  concurrentIf,
  createTestIdUrl,
  idmux,
  Identity,
  scrapeTimeout,
} from "../lib";
import { scrape, scrapeRaw } from "./lib";

async function expectSafeModeBlocked(
  body: Parameters<typeof scrapeRaw>[0],
  identity: Identity,
) {
  const res = await scrapeRaw(body, identity);
  expect(res.statusCode).toBe(403);
  expect(res.body.success).toBe(false);
  expect(res.body.code).toBe("SAFE_MODE_BLOCKED");
  return res.body;
}

describe("Safe Mode (v2 scrape, request-time)", () => {
  describe("org flag off", () => {
    let identity: Identity;

    beforeAll(async () => {
      identity = await idmux({ name: "safe-mode/unflagged" });
    }, 10000);

    it.concurrent(
      "rejects safeMode: true",
      async () => {
        const body = await expectSafeModeBlocked(
          { url: createTestIdUrl(), safeMode: true },
          identity,
        );
        expect(body.error).toMatch(/not enabled/i);
      },
      scrapeTimeout,
    );

    concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
      "treats safeMode: false as a no-op",
      async () => {
        const doc = await scrape(
          { url: createTestIdUrl(), safeMode: false },
          identity,
        );
        expect(doc.markdown).toBeDefined();
      },
      scrapeTimeout,
    );
  });

  describe("org flag on (strict defaults)", () => {
    let identity: Identity;

    beforeAll(async () => {
      identity = await idmux({
        name: "safe-mode/flagged",
        flags: { safeMode: true },
      });
    }, 10000);

    concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
      "plain scrapes still work",
      async () => {
        const doc = await scrape({ url: createTestIdUrl() }, identity);
        expect(doc.markdown).toBeDefined();
      },
      scrapeTimeout,
    );

    it.concurrent(
      "rejects stealth and enhanced proxies",
      async () => {
        for (const proxy of ["stealth", "enhanced"] as const) {
          const body = await expectSafeModeBlocked(
            { url: createTestIdUrl(), proxy },
            identity,
          );
          expect(body.error).toMatch(/prox/i);
        }
      },
      scrapeTimeout,
    );

    it.concurrent(
      "rejects browser profiles",
      async () => {
        await expectSafeModeBlocked(
          { url: createTestIdUrl(), profile: { name: "test-profile" } },
          identity,
        );
      },
      scrapeTimeout,
    );

    it.concurrent(
      "rejects login-capable actions",
      async () => {
        const body = await expectSafeModeBlocked(
          {
            url: createTestIdUrl(),
            actions: [{ type: "write", text: "hunter2" }],
          },
          identity,
        );
        expect(body.error).toMatch(/write/);
      },
      scrapeTimeout,
    );

    it.concurrent(
      "rejects credential-bearing headers, case-insensitively",
      async () => {
        for (const header of ["Authorization", "cookie"]) {
          const body = await expectSafeModeBlocked(
            { url: createTestIdUrl(), headers: { [header]: "secret" } },
            identity,
          );
          expect(body.error.toLowerCase()).toContain(header.toLowerCase());
        }
      },
      scrapeTimeout,
    );

    concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
      "allows benign headers",
      async () => {
        const doc = await scrape(
          {
            url: createTestIdUrl(),
            headers: { "Accept-Language": "en-US" },
          },
          identity,
        );
        expect(doc.markdown).toBeDefined();
      },
      scrapeTimeout,
    );

    it.concurrent(
      "rejects a bypass when the org has not allowed it",
      async () => {
        const body = await expectSafeModeBlocked(
          { url: createTestIdUrl(), safeMode: false },
          identity,
        );
        expect(body.error).toMatch(/disable Safe Mode/i);
      },
      scrapeTimeout,
    );

    concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
      "treats safeMode: true as a redundant affirmation",
      async () => {
        const doc = await scrape(
          { url: createTestIdUrl(), safeMode: true },
          identity,
        );
        expect(doc.markdown).toBeDefined();
      },
      scrapeTimeout,
    );
  });

  describe("org flag on with allowBypass", () => {
    let identity: Identity;

    beforeAll(async () => {
      identity = await idmux({
        name: "safe-mode/bypassable",
        flags: { safeMode: true, safeModeConfig: { allowBypass: true } },
      });
    }, 10000);

    concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
      "honors safeMode: false — otherwise-blocked params pass",
      async () => {
        const doc = await scrape(
          {
            url: createTestIdUrl(),
            safeMode: false,
            headers: { Authorization: "Bearer not-a-real-token" },
          },
          identity,
        );
        expect(doc.markdown).toBeDefined();
      },
      scrapeTimeout,
    );

    it.concurrent(
      "still enforces when no bypass is requested",
      async () => {
        await expectSafeModeBlocked(
          { url: createTestIdUrl(), headers: { Authorization: "x" } },
          identity,
        );
      },
      scrapeTimeout,
    );
  });
});
