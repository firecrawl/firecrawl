import request from "supertest";
import {
  ALLOW_TEST_SUITE_WEBSITE,
  concurrentIf,
  createTestIdUrl,
  describeIf,
  idmux,
  Identity,
  scrapeTimeout,
  TEST_API_URL,
  TEST_PRODUCTION,
  TEST_SUITE_WEBSITE,
} from "../lib";
import { scrape, scrapeRaw } from "./lib";

const TEST_SUITE_HOST = new URL(TEST_SUITE_WEBSITE).hostname;

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

  describeIf(TEST_PRODUCTION)("org flag on (strict defaults)", () => {
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

    it.concurrent(
      "reports basic proxy for auto requests (no stealth escalation)",
      async () => {
        const doc = await scrape(
          { url: createTestIdUrl(), proxy: "auto" },
          identity,
        );
        expect(doc.metadata?.proxyUsed).toBe("basic");
      },
      scrapeTimeout,
    );

    it.concurrent(
      "allows benign actions",
      async () => {
        const doc = await scrape(
          { url: createTestIdUrl(), actions: [{ type: "scroll" }] },
          identity,
        );
        expect(doc.markdown).toBeDefined();
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

  describeIf(TEST_PRODUCTION)("org flag on with allowBypassSafeMode", () => {
    let identity: Identity;

    beforeAll(async () => {
      identity = await idmux({
        name: "safe-mode/bypassable",
        flags: {
          safeMode: true,
          safeModeConfig: { allowBypassSafeMode: true },
        },
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

  describeIf(TEST_PRODUCTION)(
    "org config lockdown: true (lockdown supersedes)",
    () => {
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
    },
  );

  describeIf(TEST_PRODUCTION)("domainControls forces threat protection", () => {
    let identity: Identity;

    beforeAll(async () => {
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

  // Each capability is individually relaxable from the org's safeModeConfig:
  // flipping its control off restores the normal behavior while Safe Mode
  // stays on for everything else.
  describeIf(TEST_PRODUCTION)("org config relaxations", () => {
    it.concurrent(
      "disableStealthProxy: false lets a request use a stealth proxy",
      async () => {
        const identity = await idmux({
          name: "safe-mode/relax-stealth",
          flags: {
            safeMode: true,
            safeModeConfig: { disableStealthProxy: false },
          },
        });
        const res = await scrapeRaw(
          { url: createTestIdUrl(), proxy: "stealth" },
          identity,
        );
        expect(res.body.code).not.toBe("SAFE_MODE_BLOCKED");
        expect(res.statusCode).toBe(200);
      },
      scrapeTimeout,
    );

    it.concurrent(
      "disableAuthentication: false lets a request send credential headers",
      async () => {
        const identity = await idmux({
          name: "safe-mode/relax-auth",
          flags: {
            safeMode: true,
            safeModeConfig: { disableAuthentication: false },
          },
        });
        const res = await scrapeRaw(
          {
            url: createTestIdUrl(),
            headers: { Authorization: "Bearer not-a-real-token" },
          },
          identity,
        );
        expect(res.body.code).not.toBe("SAFE_MODE_BLOCKED");
        expect(res.statusCode).toBe(200);
      },
      scrapeTimeout,
    );

    it.concurrent(
      "still blocks the capabilities left at their strict default",
      async () => {
        const identity = await idmux({
          name: "safe-mode/relax-partial",
          flags: {
            safeMode: true,
            safeModeConfig: { disableStealthProxy: false },
          },
        });
        // stealth relaxed above, but authentication stays enforced
        const res = await scrapeRaw(
          { url: createTestIdUrl(), profile: { name: "test-profile" } },
          identity,
        );
        expect(res.statusCode).toBe(403);
        expect(res.body.code).toBe("SAFE_MODE_BLOCKED");
      },
      scrapeTimeout,
    );
  });

  // An allowlisted URL relaxes *how* it is scraped (evaluated per-URL), while a
  // non-matching URL under the same org stays fully strict.
  describeIf(TEST_PRODUCTION)("allowlist", () => {
    let identity: Identity;

    beforeAll(async () => {
      identity = await idmux({
        name: "safe-mode/allowlist",
        flags: {
          safeMode: true,
          safeModeConfig: { allowlist: [TEST_SUITE_HOST] },
        },
      });
    }, 10000);

    it.concurrent(
      "relaxes a stealth proxy request for an allowlisted URL",
      async () => {
        const res = await scrapeRaw(
          { url: createTestIdUrl(), proxy: "stealth" },
          identity,
        );
        expect(res.body.code).not.toBe("SAFE_MODE_BLOCKED");
        expect(res.statusCode).toBe(200);
      },
      scrapeTimeout,
    );

    it.concurrent(
      "keeps a non-allowlisted URL strict",
      async () => {
        const body = await expectSafeModeBlocked(
          { url: "https://not-in-allowlist.example.org/", proxy: "stealth" },
          identity,
        );
        expect(body.error).toMatch(/prox/i);
      },
      scrapeTimeout,
    );
  });
});
