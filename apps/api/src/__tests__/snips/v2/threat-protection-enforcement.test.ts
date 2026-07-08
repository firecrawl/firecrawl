import http from "http";
import request from "supertest";
import {
  describeIf,
  idmux,
  Identity,
  TEST_API_URL,
  TEST_PRODUCTION,
  TEST_SUITE_WEBSITE,
  scrapeTimeout,
} from "../lib";
import { crawl, crawlStart, map, scrape, scrapeRaw, search } from "./lib";
import {
  createWebRiskMockCounters,
  createWebRiskMockHandler,
  WebRiskMockDatabase,
} from "../../../lib/threat-protection/providers/web-risk/testing";

// =========================================
// Threat protection enforcement (ENG-4982/4983/4984)
//
// Most tests here use per-request threatProtection overrides with local-only
// rules (blacklist/whitelist/risk threshold), which never hit the provider —
// they only need a team with the threatProtection flag (via idmux) and are
// gated on TEST_PRODUCTION.
//
// Provider-verdict tests (risky domain, redirect re-check) need the mock
// Google Web Risk server below. The API must be started with the base-URL
// override pointing at it, e.g.:
//
//   GOOGLE_WEB_RISK_API_KEY=test \
//   GOOGLE_WEB_RISK_API_URL=http://localhost:4517 \
//   pnpm harness pnpm exec vitest run src/__tests__/snips/v2/threat-protection-enforcement.test.ts
//
// Those tests are skipped when the override is not set to a local address.
//
// Org-config-based tests (PUT /v2/team/threat-protection) additionally need
// the threat_protection_config table (DDL ships with the config PR); they
// self-skip with a warning when the config API is unavailable.
// =========================================

// Fixture domains. *.example.com is reserved (RFC 2606) — these domains are
// never actually fetched: blocked scrapes fail before any outbound request.
const BLACKLISTED_DOMAIN = "threat-blacklisted.example.com";
const RISKY_DOMAIN = "threat-risky.example.com";

// The scrape target for happy-path tests.
const CLEAN_URL = TEST_SUITE_WEBSITE;
const CLEAN_DOMAIN = new URL(TEST_SUITE_WEBSITE).hostname;

// A stable cross-hostname redirect: google.com 301s to www.google.com.
const REDIRECT_SOURCE_URL = "https://google.com/";
const REDIRECT_TARGET_DOMAIN = "www.google.com";

// Domains the mock provider's threat lists flag as MALWARE (risk score 100).
const MOCK_RISKY_DOMAINS = [RISKY_DOMAIN, REDIRECT_TARGET_DOMAIN];

// URL-level listing on the otherwise-clean test-suite domain: only this exact
// page is flagged — the domain root and every other page stay clean. Blocked
// scrapes never fetch, so the page does not need to exist.
const RISKY_URL_ON_CLEAN_DOMAIN = new URL(
  "/threat-fixture/flagged-page.html",
  TEST_SUITE_WEBSITE,
).href;

const mockProviderUrl = process.env.GOOGLE_WEB_RISK_API_URL ?? "";
const HAS_MOCK_PROVIDER =
  /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(mockProviderUrl) &&
  !!process.env.GOOGLE_WEB_RISK_API_KEY;

// Update API mock (ZDR rework): the API syncs the mock's threat lists via
// threatLists:computeDiff and confirms local prefix hits via hashes:search —
// there is no uris:search anymore, and clean domains never reach the mock.
const webRiskDb = new WebRiskMockDatabase();
for (const domain of MOCK_RISKY_DOMAINS) {
  webRiskDb.addRiskyDomain(domain, "MALWARE");
}
webRiskDb.addRiskyUrl(RISKY_URL_ON_CLEAN_DOMAIN, "MALWARE");
const webRiskCounters = createWebRiskMockCounters();
const webRiskHandler = createWebRiskMockHandler(webRiskDb, webRiskCounters);

let mockServer: http.Server | null = null;

/** hashes:search confirmations whose prefix belongs to a URL or domain. */
const providerHitsFor = (urlOrDomain: string) =>
  webRiskCounters.hashesSearchRequestsForTarget(urlOrDomain);

function startMockProvider(): Promise<void> {
  const port = Number(new URL(mockProviderUrl).port);
  mockServer = http.createServer((req, res) => {
    if (!webRiskHandler(req, res)) {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  return new Promise((resolve, reject) => {
    mockServer!.once("error", reject);
    mockServer!.listen(port, () => resolve());
  });
}

async function putThreatProtectionConfig(body: unknown, identity: Identity) {
  return await request(TEST_API_URL)
    .put("/v2/team/threat-protection")
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .set("Content-Type", "application/json")
    .send(body as object);
}

describeIf(TEST_PRODUCTION)("Threat protection enforcement", () => {
  beforeAll(async () => {
    if (HAS_MOCK_PROVIDER) {
      await startMockProvider();
    }
  });

  afterAll(async () => {
    if (mockServer) {
      await new Promise(resolve => mockServer!.close(resolve));
      mockServer = null;
    }
  });

  describe("without the team flag", () => {
    let identity: Identity;

    beforeAll(async () => {
      identity = await idmux({
        name: "threat-protection-enforcement/no-flag",
      });
    });

    it(
      "rejects any per-request threatProtection option with 403",
      async () => {
        const res = await scrapeRaw(
          {
            url: CLEAN_URL,
            threatProtection: { mode: "normal" },
          } as any,
          identity,
        );
        expect(res.statusCode).toBe(403);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toContain("enterprise feature");
      },
      scrapeTimeout,
    );
  });

  describe("with the team flag (per-request overrides)", () => {
    let identity: Identity;

    beforeAll(async () => {
      identity = await idmux({
        name: "threat-protection-enforcement/allowed",
        flags: { threatProtection: "allowed" },
        credits: 1_000_000,
      });
    });

    it(
      "scrape: clean domain passes with an active policy",
      async () => {
        // failurePolicy "open" makes this deterministic whether or not a
        // provider is configured: clean verdict → allow; no provider → allow.
        const doc = await scrape(
          {
            url: CLEAN_URL,
            threatProtection: { mode: "normal", failurePolicy: "open" },
          } as any,
          identity,
        );
        expect(doc.metadata.statusCode).toBe(200);
      },
      scrapeTimeout,
    );

    it(
      "scrape: blacklisted domain is blocked with zero provider calls",
      async () => {
        const res = await scrapeRaw(
          {
            url: `https://${BLACKLISTED_DOMAIN}/some/page`,
            threatProtection: {
              mode: "normal",
              blacklist: [BLACKLISTED_DOMAIN],
            },
          } as any,
          identity,
        );
        expect(res.statusCode).toBe(403);
        expect(res.body.success).toBe(false);
        expect(res.body.code).toBe("unsafe_domain_blocked");
        expect(res.body.error).toContain(BLACKLISTED_DOMAIN);
        if (HAS_MOCK_PROVIDER) {
          expect(providerHitsFor(BLACKLISTED_DOMAIN)).toBe(0);
        }
      },
      scrapeTimeout,
    );

    it(
      "scrape: whitelisted domain passes without a provider call",
      async () => {
        // failurePolicy "closed" + no whitelist would block when the provider
        // is unavailable — so a success here proves the whitelist
        // short-circuited the check in environments without a provider, and
        // the hit counter proves it where the mock is running.
        const before = providerHitsFor(CLEAN_DOMAIN);
        const doc = await scrape(
          {
            url: CLEAN_URL,
            threatProtection: {
              mode: "normal",
              whitelist: [CLEAN_DOMAIN],
              failurePolicy: "closed",
            },
          } as any,
          identity,
        );
        expect(doc.metadata.statusCode).toBe(200);
        if (HAS_MOCK_PROVIDER) {
          expect(providerHitsFor(CLEAN_DOMAIN)).toBe(before);
        }
      },
      scrapeTimeout,
    );

    it(
      "scrape: risk threshold blocks (verdict or fail-closed, deterministic)",
      async () => {
        // riskScoreThreshold 0 blocks any domain with a verdict (score >= 0),
        // and failurePolicy "closed" blocks when no provider is configured —
        // so this asserts the block path in every environment.
        const res = await scrapeRaw(
          {
            url: CLEAN_URL,
            threatProtection: {
              mode: "normal",
              riskScoreThreshold: 0,
              failurePolicy: "closed",
            },
          } as any,
          identity,
        );
        expect(res.statusCode).toBe(403);
        expect(res.body.success).toBe(false);
        expect(res.body.code).toBe("unsafe_domain_blocked");
      },
      scrapeTimeout,
    );

    it(
      "batch scrape: blocked URLs are rejected at enqueue, rest succeed",
      async () => {
        const start = await request(TEST_API_URL)
          .post("/v2/batch/scrape")
          .set("Authorization", `Bearer ${identity.apiKey}`)
          .set("Content-Type", "application/json")
          .send({
            urls: [CLEAN_URL, `https://${BLACKLISTED_DOMAIN}/page`],
            threatProtection: {
              mode: "normal",
              blacklist: [BLACKLISTED_DOMAIN],
              failurePolicy: "open",
            },
          });

        expect(start.statusCode).toBe(200);
        expect(start.body.success).toBe(true);
        expect(start.body.invalidURLs).toContain(
          `https://${BLACKLISTED_DOMAIN}/page`,
        );

        let status: any;
        do {
          await new Promise(resolve => setTimeout(resolve, 500));
          const res = await request(TEST_API_URL)
            .get(`/v2/batch/scrape/${start.body.id}`)
            .set("Authorization", `Bearer ${identity.apiKey}`)
            .send();
          expect(res.statusCode).toBe(200);
          status = res.body;
        } while (status.status === "scraping");

        expect(status.status).toBe("completed");
        expect(status.data.length).toBe(1);
        expect(status.data[0].metadata.sourceURL).toBe(CLEAN_URL);
      },
      scrapeTimeout * 2,
    );

    it(
      "crawl: blocked seed URL is rejected at kickoff",
      async () => {
        const res = await crawlStart(
          {
            url: `https://${BLACKLISTED_DOMAIN}/`,
            limit: 2,
            scrapeOptions: {
              threatProtection: {
                mode: "normal",
                blacklist: [BLACKLISTED_DOMAIN],
              },
            },
          } as any,
          identity,
        );
        expect(res.statusCode).toBe(403);
        expect(res.body.success).toBe(false);
        expect(res.body.code).toBe("unsafe_domain_blocked");
      },
      scrapeTimeout,
    );

    it(
      "crawl: blocked discoveries are skipped and the crawl completes",
      async () => {
        const blockedDiscoveryDomain = "github.com";
        const res = await crawl(
          {
            url: CLEAN_URL,
            limit: 3,
            maxDiscoveryDepth: 1,
            scrapeOptions: {
              threatProtection: {
                mode: "normal",
                blacklist: [blockedDiscoveryDomain],
                failurePolicy: "open",
              },
            },
          } as any,
          identity,
        );
        expect(res.status).toBe("completed");
        expect(res.data.length).toBeGreaterThan(0);
        for (const doc of res.data) {
          const url = doc.metadata.url ?? doc.metadata.sourceURL;
          if (!url) continue;
          const hostname = new URL(url).hostname;
          expect(
            hostname === blockedDiscoveryDomain ||
              hostname.endsWith(`.${blockedDiscoveryDomain}`),
          ).toBe(false);
        }
      },
      scrapeTimeout * 5,
    );

    it(
      "map: blocked domains are filtered out of the returned URL list",
      async () => {
        const blockedSubdomain = `docs.${CLEAN_DOMAIN}`;
        const res = await map(
          {
            url: CLEAN_URL,
            limit: 100,
            includeSubdomains: true,
            threatProtection: {
              mode: "normal",
              blacklist: [blockedSubdomain],
              failurePolicy: "open",
            },
          } as any,
          identity,
        );
        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        for (const link of res.body.links) {
          const hostname = new URL(link.url).hostname;
          expect(
            hostname === blockedSubdomain ||
              hostname.endsWith(`.${blockedSubdomain}`),
          ).toBe(false);
        }
      },
      scrapeTimeout,
    );

    it(
      "search: blocked domains are removed from results entirely",
      async () => {
        const results = await search(
          {
            query: "firecrawl",
            limit: 10,
            threatProtection: {
              mode: "normal",
              blacklist: ["firecrawl.dev"],
              failurePolicy: "open",
            },
          } as any,
          identity,
        );
        for (const result of results.web ?? []) {
          const hostname = new URL(result.url).hostname;
          expect(
            hostname === "firecrawl.dev" || hostname.endsWith(".firecrawl.dev"),
          ).toBe(false);
        }
      },
      scrapeTimeout,
    );

    it(
      "extract: blocked target URLs are rejected before fetching",
      async () => {
        const res = await request(TEST_API_URL)
          .post("/v2/extract")
          .set("Authorization", `Bearer ${identity.apiKey}`)
          .set("Content-Type", "application/json")
          .send({
            urls: [`https://${BLACKLISTED_DOMAIN}/page`],
            prompt: "Extract the page title.",
            ignoreInvalidURLs: false,
            threatProtection: {
              mode: "normal",
              blacklist: [BLACKLISTED_DOMAIN],
            },
          });
        expect(res.statusCode).toBe(403);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toContain(BLACKLISTED_DOMAIN);
      },
      scrapeTimeout,
    );
  });

  describe("provider verdicts (mock Google Web Risk)", () => {
    let identity: Identity;

    beforeAll(async () => {
      if (!HAS_MOCK_PROVIDER) return;
      identity = await idmux({
        name: "threat-protection-enforcement/provider",
        flags: { threatProtection: "allowed" },
        credits: 1_000_000,
      });
    });

    (HAS_MOCK_PROVIDER ? it : it.skip)(
      "scrape: risky domain is blocked by the provider verdict",
      async () => {
        const res = await scrapeRaw(
          {
            url: `https://${RISKY_DOMAIN}/`,
            threatProtection: { mode: "normal", failurePolicy: "open" },
          } as any,
          identity,
        );
        expect(res.statusCode).toBe(403);
        expect(res.body.success).toBe(false);
        expect(res.body.code).toBe("unsafe_domain_blocked");
        // The domain's hash prefix is in the synced local list; the block
        // required a hashes:search confirmation against the mock.
        expect(res.body.error).toContain(RISKY_DOMAIN);
        expect(providerHitsFor(RISKY_DOMAIN)).toBeGreaterThanOrEqual(1);
      },
      scrapeTimeout,
    );

    (HAS_MOCK_PROVIDER ? it : it.skip)(
      "scrape: flagged URL is blocked while the rest of its domain stays scrapeable",
      async () => {
        // Checks are URL-level: only the listed page's expression matches,
        // so the block requires a hashes:search confirmation for the URL…
        const blocked = await scrapeRaw(
          {
            url: RISKY_URL_ON_CLEAN_DOMAIN,
            threatProtection: { mode: "normal", failurePolicy: "open" },
          } as any,
          identity,
        );
        expect(blocked.statusCode).toBe(403);
        expect(blocked.body.success).toBe(false);
        expect(blocked.body.code).toBe("unsafe_domain_blocked");
        expect(blocked.body.error).toContain("/threat-fixture/flagged-page");
        expect(
          providerHitsFor(RISKY_URL_ON_CLEAN_DOMAIN),
        ).toBeGreaterThanOrEqual(1);

        // …while the same policy still scrapes the domain root fine.
        const doc = await scrape(
          {
            url: CLEAN_URL,
            threatProtection: { mode: "normal", failurePolicy: "open" },
          } as any,
          identity,
        );
        expect(doc.metadata.statusCode).toBe(200);
      },
      scrapeTimeout * 2,
    );

    (HAS_MOCK_PROVIDER ? it : it.skip)(
      "scrape: clean domain redirecting to a blocked domain is blocked",
      async () => {
        // google.com 301s to www.google.com; the mock flags only the
        // redirect target as risky, so the initial check passes and the
        // redirect re-check must catch it.
        const res = await scrapeRaw(
          {
            url: REDIRECT_SOURCE_URL,
            threatProtection: { mode: "normal", failurePolicy: "open" },
          } as any,
          identity,
        );
        expect(res.statusCode).toBe(403);
        expect(res.body.success).toBe(false);
        expect(res.body.code).toBe("unsafe_domain_blocked");
        expect(res.body.error).toContain(REDIRECT_TARGET_DOMAIN);
      },
      scrapeTimeout,
    );
  });

  describe("with the team flag forced", () => {
    let identity: Identity;

    beforeAll(async () => {
      identity = await idmux({
        name: "threat-protection-enforcement/forced",
        flags: { threatProtection: "forced" },
        credits: 100_000,
      });
    });

    it(
      "rejects a per-request override that disables threat protection",
      async () => {
        const res = await scrapeRaw(
          {
            url: CLEAN_URL,
            threatProtection: { mode: "off" },
          } as any,
          identity,
        );
        expect(res.statusCode).toBe(403);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toContain("cannot be disabled");
      },
      scrapeTimeout,
    );

    it(
      "still allows narrowing overrides (mode stays on)",
      async () => {
        const res = await scrapeRaw(
          {
            url: `https://${BLACKLISTED_DOMAIN}/`,
            threatProtection: {
              mode: "normal",
              blacklist: [BLACKLISTED_DOMAIN],
            },
          } as any,
          identity,
        );
        expect(res.statusCode).toBe(403);
        expect(res.body.code).toBe("unsafe_domain_blocked");
      },
      scrapeTimeout,
    );
  });

  describe("org config enforcement + override lockout", () => {
    let identity: Identity;
    let configApiAvailable = false;

    beforeAll(async () => {
      identity = await idmux({
        name: "threat-protection-enforcement/org-config",
        flags: { threatProtection: "allowed" },
        credits: 100_000,
      });

      // The config API needs the threat_protection_config table (DDL ships
      // with the config PR). Skip these tests gracefully where it is not
      // provisioned yet.
      const res = await putThreatProtectionConfig(
        {
          mode: "normal",
          blacklist: [BLACKLISTED_DOMAIN],
          failurePolicy: "open",
          allowRequestOverrides: true,
        },
        identity,
      );
      configApiAvailable = res.statusCode === 200;
      if (!configApiAvailable) {
        console.warn(
          "threat protection config API unavailable (missing DDL?); skipping org config tests",
          res.statusCode,
          res.body,
        );
      }
    });

    afterAll(async () => {
      if (configApiAvailable) {
        // Reset so reruns against the same idmux team start clean.
        await putThreatProtectionConfig(
          { mode: "off", allowRequestOverrides: true },
          identity,
        );
      }
    });

    it(
      "org policy applies without any per-request option",
      async () => {
        if (!configApiAvailable) return;
        const res = await scrapeRaw(
          { url: `https://${BLACKLISTED_DOMAIN}/` },
          identity,
        );
        expect(res.statusCode).toBe(403);
        expect(res.body.success).toBe(false);
        expect(res.body.code).toBe("unsafe_domain_blocked");
      },
      scrapeTimeout,
    );

    it(
      "request override is rejected when the org locks overrides down",
      async () => {
        if (!configApiAvailable) return;
        const lock = await putThreatProtectionConfig(
          {
            mode: "normal",
            blacklist: [BLACKLISTED_DOMAIN],
            failurePolicy: "open",
            allowRequestOverrides: false,
          },
          identity,
        );
        expect(lock.statusCode).toBe(200);

        // The org config read is cached for ~60s; the PUT invalidates it, so
        // the lockout applies immediately.
        const res = await scrapeRaw(
          {
            url: CLEAN_URL,
            threatProtection: { whitelist: [BLACKLISTED_DOMAIN] },
          } as any,
          identity,
        );
        expect(res.statusCode).toBe(403);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toContain("overrides are disabled");
      },
      scrapeTimeout,
    );
  });
});
