import request from "supertest";
import {
  ALLOW_TEST_SUITE_WEBSITE,
  concurrentIf,
  createTestIdUrl,
  idmux,
  Identity,
  scrapeTimeout,
  TEST_API_URL,
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

  describe("org config lockdown: true (lockdown supersedes)", () => {
    let identity: Identity;

    beforeAll(async () => {
      identity = await idmux({
        name: "safe-mode/lockdown",
        flags: { safeMode: true, safeModeConfig: { lockdown: true } },
      });
    }, 10000);

    it.concurrent(
      "uncached URLs return the lockdown cache-miss error",
      async () => {
        const res = await scrapeRaw({ url: createTestIdUrl() }, identity);
        expect(res.statusCode).toBe(404);
        expect(res.body.success).toBe(false);
        expect(res.body.code).toBe("SCRAPE_LOCKDOWN_CACHE_MISS");
      },
      scrapeTimeout,
    );

    it.concurrent(
      "accepts and ignores params the other controls would reject",
      async () => {
        // Not a 403: under lockdown the params are inert, so the request
        // proceeds into lockdown machinery and fails only on the cache miss.
        const res = await scrapeRaw(
          {
            url: createTestIdUrl(),
            proxy: "stealth",
            profile: { name: "ignored" },
            headers: { Cookie: "ignored" },
          },
          identity,
        );
        expect(res.body.code).toBe("SCRAPE_LOCKDOWN_CACHE_MISS");
        expect(res.body.code).not.toBe("SAFE_MODE_BLOCKED");
      },
      scrapeTimeout,
    );
  });

  describe("domainControls forces threat protection", () => {
    let identity: Identity;

    beforeAll(async () => {
      // threatProtection: "allowed" lets the test save a TP config; Safe
      // Mode's domainControls must enforce it even with mode: "off".
      identity = await idmux({
        name: "safe-mode/domain-controls",
        flags: { safeMode: true, threatProtection: "allowed" },
      });
      const res = await request(TEST_API_URL)
        .put("/v2/team/threat-protection")
        .set("Authorization", `Bearer ${identity.apiKey}`)
        .set("Content-Type", "application/json")
        .send({ mode: "off", blacklist: ["blocked.example.com"] });
      expect(res.statusCode).toBe(200);
    }, 15000);

    it.concurrent(
      "blocks blacklisted domains even though the TP config mode is off",
      async () => {
        const res = await scrapeRaw(
          { url: "https://blocked.example.com/page" },
          identity,
        );
        expect(res.body.success).toBe(false);
        expect(res.body.code).toBe("unsafe_domain_blocked");
      },
      scrapeTimeout,
    );

    it.concurrent(
      "rejects a request-level threat protection opt-out",
      async () => {
        const res = await scrapeRaw(
          { url: createTestIdUrl(), threatProtection: { mode: "off" } },
          identity,
        );
        expect(res.statusCode).toBe(403);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/threat protection/i);
      },
      scrapeTimeout,
    );
  });
});
