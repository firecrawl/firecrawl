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
import { scrape, scrapeRaw } from "./lib";
import {
  createZscalerMockCounters,
  createZscalerMockHandler,
  type ZscalerMockDatabase,
} from "../../../lib/threat-protection/providers/zscaler/testing";

// =========================================
// Threat protection "zscaler" mode
//
// Config-API tests need a team with the threatProtection flag (idmux) and
// are gated on TEST_PRODUCTION; the ones that store a client secret also
// need SIEM_LOGGING_ENCRYPTION_KEY (shared org-secret encryption key).
//
// Enforcement tests additionally need the mock ZIA server below. The API
// must be started with the base-URL overrides pointing at it, e.g.:
//
//   SIEM_LOGGING_ENCRYPTION_KEY=<32-byte hex> \
//   ZSCALER_TOKEN_URL_OVERRIDE=http://localhost:4519/oauth2/v1/token \
//   ZSCALER_API_URL_OVERRIDE=http://localhost:4519 \
//   pnpm harness pnpm exec vitest run src/__tests__/snips/v2/threat-protection-zscaler.test.ts
//
// Those tests self-skip when the override is not set to a local address.
// =========================================

const HAS_ENCRYPTION_KEY = !!process.env.SIEM_LOGGING_ENCRYPTION_KEY;

const mockApiUrl = process.env.ZSCALER_API_URL_OVERRIDE ?? "";
const HAS_MOCK_PROVIDER =
  /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(mockApiUrl) &&
  HAS_ENCRYPTION_KEY;

// Fixture domains. *.example.com is reserved (RFC 2606) — blocked scrapes
// fail before any outbound request, so these never need to exist.
const CASINO_DOMAIN = "threat-zscaler-casino.example.com";
const VENDOR_DOMAIN = "threat-zscaler-vendor.example.com";
const UNKNOWN_DOMAIN = "threat-zscaler-unknown.example.com";
const CLEAN_URL = TEST_SUITE_WEBSITE;

const MOCK_CLIENT_ID = "firecrawl-test-client";
const MOCK_CLIENT_SECRET = "firecrawl-test-secret";

const zscalerDb: ZscalerMockDatabase = {
  clientId: MOCK_CLIENT_ID,
  clientSecret: MOCK_CLIENT_SECRET,
  categories: [
    { id: "GAMBLING" },
    { id: "NEWS_AND_MEDIA" },
    {
      id: "CUSTOM_01",
      configuredName: "Blocked Vendors",
      customCategory: true,
      urls: [VENDOR_DOMAIN],
    },
  ],
  classifications: {
    [CASINO_DOMAIN]: {
      urlClassifications: ["GAMBLING"],
      urlClassificationsWithSecurityAlert: [],
    },
  },
};
const zscalerCounters = createZscalerMockCounters();

let mockServer: http.Server | null = null;

function startMockProvider(): Promise<void> {
  const port = Number(new URL(mockApiUrl).port);
  mockServer = http.createServer(
    createZscalerMockHandler(zscalerDb, zscalerCounters),
  );
  return new Promise((resolve, reject) => {
    mockServer!.once("error", reject);
    mockServer!.listen(port, () => resolve());
  });
}

async function getConfigRaw(identity: Identity) {
  return await request(TEST_API_URL)
    .get("/v2/team/threat-protection")
    .set("Authorization", `Bearer ${identity.apiKey}`);
}

async function putConfigRaw(body: unknown, identity: Identity) {
  return await request(TEST_API_URL)
    .put("/v2/team/threat-protection")
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .set("Content-Type", "application/json")
    .send(body as object);
}

async function postRaw(path: string, body: unknown, identity: Identity) {
  return await request(TEST_API_URL)
    .post(path)
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .set("Content-Type", "application/json")
    .send((body ?? {}) as object);
}

function zscalerConfigDoc(overrides: Record<string, unknown> = {}) {
  return {
    mode: "zscaler",
    failurePolicy: "closed",
    zscaler: {
      clientId: MOCK_CLIENT_ID,
      clientSecret: MOCK_CLIENT_SECRET,
      vanityDomain: "testtenant",
      deniedCategories: ["GAMBLING", "CUSTOM_01"],
      ...overrides,
    },
  };
}

describeIf(TEST_PRODUCTION)("Threat protection zscaler config API", () => {
  let identity: Identity;

  beforeAll(async () => {
    identity = await idmux({
      name: "threat-protection-zscaler/config",
      flags: { threatProtection: "allowed" },
    });
  });

  it('PUT rejects mode "zscaler" without a connection block', async () => {
    const res = await putConfigRaw({ mode: "zscaler" }, identity);
    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("zscaler");
  });

  it("test-connection without stored or inline credentials returns 400", async () => {
    const res = await postRaw(
      "/v2/team/threat-protection/zscaler/test-connection",
      {},
      identity,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("categories endpoint without a connection returns 400", async () => {
    const res = await request(TEST_API_URL)
      .get("/v2/team/threat-protection/zscaler/categories")
      .set("Authorization", `Bearer ${identity.apiKey}`);
    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
  });

  describeIf(HAS_ENCRYPTION_KEY)("with the encryption key", () => {
    it("stores the connection, never serves the secret back", async () => {
      const put = await putConfigRaw(zscalerConfigDoc(), identity);
      expect(put.statusCode).toBe(200);
      expect(put.body.success).toBe(true);
      expect(put.body.data.mode).toBe("zscaler");
      expect(put.body.data.zscaler).toMatchObject({
        clientId: MOCK_CLIENT_ID,
        hasClientSecret: true,
        vanityDomain: "testtenant",
        deniedCategories: ["GAMBLING", "CUSTOM_01"],
        syncIntervalMinutes: 60,
      });
      expect(JSON.stringify(put.body)).not.toContain(MOCK_CLIENT_SECRET);

      const get = await getConfigRaw(identity);
      expect(get.statusCode).toBe(200);
      expect(get.body.data.zscaler).toMatchObject({
        clientId: MOCK_CLIENT_ID,
        hasClientSecret: true,
      });
      expect(JSON.stringify(get.body)).not.toContain(MOCK_CLIENT_SECRET);
    });

    it("keeps the stored secret when the update omits it", async () => {
      const doc = zscalerConfigDoc({ deniedCategories: ["GAMBLING"] });
      delete (doc.zscaler as Record<string, unknown>).clientSecret;
      const put = await putConfigRaw(doc, identity);
      expect(put.statusCode).toBe(200);
      expect(put.body.data.zscaler).toMatchObject({
        hasClientSecret: true,
        deniedCategories: ["GAMBLING"],
      });
    });

    it("requires a new secret when the client ID changes", async () => {
      const doc = zscalerConfigDoc({ clientId: "different-client" });
      delete (doc.zscaler as Record<string, unknown>).clientSecret;
      const put = await putConfigRaw(doc, identity);
      expect(put.statusCode).toBe(400);
      expect(put.body.success).toBe(false);
      expect(put.body.error).toContain("clientSecret");
    });

    it("clears the connection when the block is removed", async () => {
      const put = await putConfigRaw({ mode: "off" }, identity);
      expect(put.statusCode).toBe(200);
      expect(put.body.data.zscaler).toBeNull();

      // Re-configuring after a clear needs the secret again.
      const doc = zscalerConfigDoc();
      delete (doc.zscaler as Record<string, unknown>).clientSecret;
      const rePut = await putConfigRaw(doc, identity);
      expect(rePut.statusCode).toBe(400);
    });
  });
});

describeIf(TEST_PRODUCTION && HAS_MOCK_PROVIDER)(
  "Threat protection zscaler enforcement (mock ZIA)",
  () => {
    let identity: Identity;

    beforeAll(async () => {
      await startMockProvider();
      identity = await idmux({
        name: "threat-protection-zscaler/enforcement",
        flags: { threatProtection: "allowed" },
        credits: 1_000_000,
      });

      const put = await putConfigRaw(zscalerConfigDoc(), identity);
      expect(put.statusCode).toBe(200);

      // Deterministic setup: force the custom-list sync before enforcement.
      const sync = await postRaw(
        "/v2/team/threat-protection/zscaler/sync",
        {},
        identity,
      );
      expect(sync.statusCode).toBe(200);
      expect(sync.body.data.syncStatus.lastSyncedAt).not.toBeNull();
      expect(sync.body.data.syncStatus.ruleCount).toBeGreaterThanOrEqual(1);
    }, 60_000);

    afterAll(async () => {
      if (mockServer) {
        await new Promise(resolve => mockServer!.close(resolve));
        mockServer = null;
      }
    });

    beforeEach(() => {
      zscalerDb.rateLimitLookups = false;
    });

    it("connection test passes against the mock tenant", async () => {
      const res = await postRaw(
        "/v2/team/threat-protection/zscaler/test-connection",
        {},
        identity,
      );
      expect(res.statusCode).toBe(200);
      expect(res.body.data).toMatchObject({
        ok: true,
        tokenOk: true,
        categoriesOk: true,
        lookupOk: true,
      });
    });

    it("connection test distinguishes bad credentials", async () => {
      const res = await postRaw(
        "/v2/team/threat-protection/zscaler/test-connection",
        {
          zscaler: {
            clientId: "wrong-client",
            clientSecret: "wrong-secret",
            vanityDomain: "testtenant",
          },
        },
        identity,
      );
      expect(res.statusCode).toBe(200);
      expect(res.body.data).toMatchObject({
        ok: false,
        tokenOk: false,
        error: { kind: "auth" },
      });
    });

    it("serves the synced taxonomy for the category picker", async () => {
      const res = await request(TEST_API_URL)
        .get("/v2/team/threat-protection/zscaler/categories")
        .set("Authorization", `Bearer ${identity.apiKey}`);
      expect(res.statusCode).toBe(200);
      const ids = res.body.data.categories.map(
        (category: { id: string }) => category.id,
      );
      expect(ids).toContain("GAMBLING");
      expect(ids).toContain("CUSTOM_01");
      const custom = res.body.data.categories.find(
        (category: { id: string }) => category.id === "CUSTOM_01",
      );
      expect(custom).toMatchObject({ name: "Blocked Vendors", custom: true });
    });

    it(
      "scrape: a denied Zscaler-defined category blocks via urlLookup",
      async () => {
        const res = await scrapeRaw(
          { url: `https://${CASINO_DOMAIN}/` } as any,
          identity,
        );
        expect(res.statusCode).toBe(403);
        expect(res.body.success).toBe(false);
        expect(res.body.code).toBe("unsafe_domain_blocked");
        expect(res.body.error).toContain(CASINO_DOMAIN);
      },
      scrapeTimeout,
    );

    it(
      "scrape: a denied custom-list domain blocks from synced rules, no lookup",
      async () => {
        const lookupCallsBefore = zscalerCounters.lookupCalls;
        const res = await scrapeRaw(
          { url: `https://${VENDOR_DOMAIN}/any/page` } as any,
          identity,
        );
        expect(res.statusCode).toBe(403);
        expect(res.body.code).toBe("unsafe_domain_blocked");
        expect(res.body.error).toContain(VENDOR_DOMAIN);
        // Custom-list decisions never spend the tenant's lookup budget.
        expect(zscalerCounters.lookupCalls).toBe(lookupCallsBefore);
      },
      scrapeTimeout,
    );

    it(
      "scrape: a clean domain passes with the lookup consulted",
      async () => {
        const lookupUrlsBefore = zscalerCounters.lookupUrls;
        const doc = await scrape({ url: CLEAN_URL } as any, identity);
        expect(doc.metadata.statusCode).toBe(200);
        expect(zscalerCounters.lookupUrls).toBeGreaterThan(lookupUrlsBefore);
      },
      scrapeTimeout,
    );

    it(
      "scrape: provider failure resolves through failurePolicy closed",
      async () => {
        zscalerDb.rateLimitLookups = true;
        const res = await scrapeRaw(
          { url: `https://${UNKNOWN_DOMAIN}/` } as any,
          identity,
        );
        expect(res.statusCode).toBe(403);
        expect(res.body.code).toBe("unsafe_domain_blocked");
      },
      scrapeTimeout,
    );
  },
);
