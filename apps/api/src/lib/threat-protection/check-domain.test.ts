import http from "http";
import { AddressInfo } from "net";

// checkDomain is enforcement-only: it emits/exports no security events, so
// there are no event sinks to stub here.
// The Web Risk threat-list store lives on the durable Redis connection —
// swap in an in-memory fake. (fake-redis.ts has no runtime imports, so the
// factory cannot re-enter the module being mocked.)
vi.mock("../../services/queue-service", async () => {
  const { createFakeWebRiskRedis } = await import(
    "./providers/web-risk/fake-redis.js"
  );
  const client = createFakeWebRiskRedis();
  return { getRedisConnection: () => client };
});

import { config } from "../../config";
import {
  checkDomain,
  THREAT_PROTECTION_POLICY_DEFAULTS,
  ThreatCheckDedup,
  ThreatProtectionPolicy,
  UnsafeDomainBlockedError,
} from "./index";
import {
  createWebRiskMockCounters,
  createWebRiskMockHandler,
  WebRiskMockDatabase,
} from "./providers/web-risk/testing";

function policy(
  overrides: Partial<ThreatProtectionPolicy> = {},
): ThreatProtectionPolicy {
  return {
    mode: "normal",
    ...THREAT_PROTECTION_POLICY_DEFAULTS,
    ...overrides,
  };
}

// The mock provider: a flagged fixture domain in the MALWARE list, served
// through the Update API endpoints (computeDiff for the local list sync,
// hashes:search for prefix-hit confirmation).
const RISKY_DOMAIN = "threat-risky.example";

const db = new WebRiskMockDatabase();
db.addRiskyDomain(RISKY_DOMAIN, "MALWARE");

const counters = createWebRiskMockCounters();
const webRiskHandler = createWebRiskMockHandler(db, counters);

// While > 0, hashes:search requests fail with 503 (decremented per request);
// Infinity = permanently down (provider-failure paths).
let failHashesSearches = 0;

let server: http.Server;

const originalConfig = {
  webRiskUrl: config.GOOGLE_WEB_RISK_API_URL,
  webRiskKey: config.GOOGLE_WEB_RISK_API_KEY,
};

beforeAll(async () => {
  await new Promise<void>(resolve => {
    server = http.createServer((req, res) => {
      if (
        failHashesSearches > 0 &&
        (req.url ?? "").startsWith("/v1/hashes:search")
      ) {
        failHashesSearches--;
        res.statusCode = 503;
        res.end("{}");
        return;
      }
      if (!webRiskHandler(req, res)) {
        res.statusCode = 404;
        res.end("{}");
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      config.GOOGLE_WEB_RISK_API_URL = `http://127.0.0.1:${addr.port}`;
      config.GOOGLE_WEB_RISK_API_KEY = "test-web-risk-key";
      resolve();
    });
  });
});

afterAll(async () => {
  config.GOOGLE_WEB_RISK_API_URL = originalConfig.webRiskUrl;
  config.GOOGLE_WEB_RISK_API_KEY = originalConfig.webRiskKey;
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => {
  failHashesSearches = 0;
});

const riskyHits = () => counters.hashesSearchRequestsForDomain(RISKY_DOMAIN);

describe("checkDomain", () => {
  it("allows immediately when mode is off, with no provider call", async () => {
    const before = counters.hashesSearchRequests;
    const decision = await checkDomain("example.com", policy({ mode: "off" }), {
      teamId: "team-1",
    });

    expect(decision).toEqual({
      allowed: true,
      rule: "default-allow",
      providerConsulted: false,
      verdict: null,
      mode: "off",
    });
    expect(counters.hashesSearchRequests).toBe(before);
  });

  it("skips the provider scan when a local rule is decisive", async () => {
    const before = counters.hashesSearchRequests;
    const decision = await checkDomain(
      "cdn.blocked.com",
      policy({ blacklist: ["blocked.com"] }),
      { teamId: "team-1" },
    );

    expect(decision).toMatchObject({
      allowed: false,
      rule: "blacklist",
      providerConsulted: false,
      verdict: null,
    });
    expect(counters.hashesSearchRequests).toBe(before);
  });

  it("consults the provider and blocks a flagged domain (fresh scan)", async () => {
    const before = riskyHits();
    const decision = await checkDomain(RISKY_DOMAIN.toUpperCase(), policy(), {
      teamId: "team-1",
    });

    expect(decision).toMatchObject({
      allowed: false,
      rule: "risk-score",
      providerConsulted: true,
      mode: "normal",
    });
    expect(decision.verdict).toMatchObject({
      provider: "google-web-risk",
      riskScore: 100,
      categories: ["MALWARE"],
      fromCache: false,
    });
    // The threat list synced locally; the hit was confirmed by exactly one
    // hashes:search call carrying only the anonymized hash prefix.
    expect(counters.computeDiffRequests).toBeGreaterThanOrEqual(3);
    expect(riskyHits()).toBe(before + 1);
  });

  it("resolves clean domains locally with zero Google calls", async () => {
    const before = counters.hashesSearchRequests;
    const decision = await checkDomain("safe.example", policy(), {});

    expect(decision).toMatchObject({
      allowed: true,
      rule: "default-allow",
      providerConsulted: true,
    });
    expect(decision.verdict?.fromCache).toBe(false);
    expect(counters.hashesSearchRequests).toBe(before);
  });

  it("re-scans on a second lookup without a dedup handle (no verdict cache)", async () => {
    const before = riskyHits();

    const first = await checkDomain(RISKY_DOMAIN, policy(), {});
    const second = await checkDomain(RISKY_DOMAIN, policy(), {});

    expect(first).toMatchObject({ allowed: false, providerConsulted: true });
    expect(second).toMatchObject({ allowed: false, providerConsulted: true });
    expect(second).not.toBe(first);
    // Two independent scans, two confirmation calls — nothing was cached.
    expect(riskyHits()).toBe(before + 2);
  });

  it("shares one in-flight decision within a request via ctx.dedup", async () => {
    const before = riskyHits();
    const dedup: ThreatCheckDedup = new Map();

    // Concurrent + sequential re-checks of the same domain in one request.
    const [first, second] = await Promise.all([
      checkDomain(RISKY_DOMAIN, policy(), { dedup }),
      checkDomain(RISKY_DOMAIN, policy(), { dedup }),
    ]);
    const third = await checkDomain(`${RISKY_DOMAIN}.`, policy(), { dedup });

    // Same decision object → a single scan → a single billable decision.
    expect(second).toBe(first);
    expect(third).toBe(first); // normalization applies before dedup
    expect(riskyHits()).toBe(before + 1);
  });

  it("scans each distinct domain in a dedup scope separately", async () => {
    const dedup: ThreatCheckDedup = new Map();
    const before = riskyHits();

    const clean = await checkDomain("safe.example", policy(), { dedup });
    const risky = await checkDomain(RISKY_DOMAIN, policy(), { dedup });

    expect(clean.allowed).toBe(true);
    expect(risky.allowed).toBe(false);
    expect(riskyHits()).toBe(before + 1);
  });

  it("retries once and succeeds when the first confirmation attempt fails", async () => {
    failHashesSearches = 1; // exactly the first hashes:search attempt 503s

    const decision = await checkDomain(RISKY_DOMAIN, policy(), {});

    expect(decision).toMatchObject({
      allowed: false,
      rule: "risk-score",
      providerConsulted: true,
    });
    expect(failHashesSearches).toBe(0);
  });

  it("fails closed when confirmation is down and failurePolicy is closed", async () => {
    failHashesSearches = Infinity;

    const decision = await checkDomain(
      RISKY_DOMAIN,
      policy({ failurePolicy: "closed" }),
      { teamId: "team-1" },
    );

    expect(decision).toEqual({
      allowed: false,
      rule: "provider-failure",
      providerConsulted: false,
      verdict: null,
      mode: "normal",
    });
  });

  it("fails open when confirmation is down and failurePolicy is open", async () => {
    failHashesSearches = Infinity;

    const decision = await checkDomain(
      RISKY_DOMAIN,
      policy({ failurePolicy: "open" }),
      {},
    );

    expect(decision).toMatchObject({
      allowed: true,
      rule: "provider-failure",
      providerConsulted: false,
      verdict: null,
    });
  });
});

describe("UnsafeDomainBlockedError", () => {
  it("carries the decision and the unsafe_domain_blocked code", async () => {
    const decision = await checkDomain(
      "bad.example",
      policy({ blacklist: ["bad.example"] }),
      {},
    );
    const error = new UnsafeDomainBlockedError("bad.example", decision);

    expect(error.code).toBe("unsafe_domain_blocked");
    expect(error.name).toBe("UnsafeDomainBlockedError");
    expect(error.domain).toBe("bad.example");
    expect(error.decision).toBe(decision);
    expect(error.message).toContain("threat protection policy");
    expect(error.message).toContain("blacklist");
  });
});
