import http from "http";
import { AddressInfo } from "net";

// checkUrl is enforcement-only: it emits/exports no security events, so
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
  checkUrl,
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

// The mock provider: a flagged fixture domain plus a flagged single URL on an
// otherwise-clean domain, both in the MALWARE list, served through the Update
// API endpoints (computeDiff for the local list sync, hashes:search for
// prefix-hit confirmation).
const RISKY_DOMAIN = "threat-risky.example";
const RISKY_URL = "http://threat-mixed.example/downloads/malware-installer.exe";

const db = new WebRiskMockDatabase();
db.addRiskyDomain(RISKY_DOMAIN, "MALWARE");
db.addRiskyUrl(RISKY_URL, "MALWARE");

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

const riskyHits = () => counters.hashesSearchRequestsForTarget(RISKY_DOMAIN);

describe("checkUrl", () => {
  it("allows immediately when mode is off, with no provider call", async () => {
    const before = counters.hashesSearchRequests;
    const decision = await checkUrl("example.com", policy({ mode: "off" }), {
      teamId: "team-1",
    });

    expect(decision).toEqual({
      allowed: true,
      rule: "default-allow",
      url: "http://example.com/",
      domain: "example.com",
      providerConsulted: false,
      verdict: null,
      mode: "off",
    });
    expect(counters.hashesSearchRequests).toBe(before);
  });

  it("skips the provider scan when a local rule is decisive", async () => {
    const before = counters.hashesSearchRequests;
    const decision = await checkUrl(
      "https://cdn.blocked.com/some/page",
      policy({ blacklist: ["blocked.com"] }),
      { teamId: "team-1" },
    );

    expect(decision).toMatchObject({
      allowed: false,
      rule: "blacklist",
      domain: "cdn.blocked.com",
      providerConsulted: false,
      verdict: null,
    });
    expect(counters.hashesSearchRequests).toBe(before);
  });

  it("consults the provider and blocks a flagged domain (fresh scan)", async () => {
    const before = riskyHits();
    const decision = await checkUrl(RISKY_DOMAIN.toUpperCase(), policy(), {
      teamId: "team-1",
    });

    expect(decision).toMatchObject({
      allowed: false,
      rule: "risk-score",
      domain: RISKY_DOMAIN,
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

  it("blocks every URL on a flagged domain (host-suffix expressions)", async () => {
    const decision = await checkUrl(
      `https://${RISKY_DOMAIN}/any/path?query=1`,
      policy(),
      { teamId: "team-1" },
    );

    expect(decision).toMatchObject({
      allowed: false,
      rule: "risk-score",
      domain: RISKY_DOMAIN,
      providerConsulted: true,
    });
  });

  it("blocks a flagged URL while keeping its domain's other URLs clean", async () => {
    const flagged = await checkUrl(RISKY_URL, policy(), { teamId: "team-1" });
    const sibling = await checkUrl(
      "http://threat-mixed.example/downloads/press-kit.zip",
      policy(),
      { teamId: "team-1" },
    );
    const root = await checkUrl("http://threat-mixed.example/", policy(), {
      teamId: "team-1",
    });

    expect(flagged).toMatchObject({
      allowed: false,
      rule: "risk-score",
      domain: "threat-mixed.example",
      providerConsulted: true,
    });
    expect(flagged.verdict).toMatchObject({ riskScore: 100 });
    expect(sibling).toMatchObject({
      allowed: true,
      rule: "default-allow",
      providerConsulted: true,
    });
    expect(root).toMatchObject({ allowed: true, rule: "default-allow" });
  });

  it("resolves clean URLs locally with zero Google calls", async () => {
    const before = counters.hashesSearchRequests;
    const decision = await checkUrl(
      "https://safe.example/pricing",
      policy(),
      {},
    );

    expect(decision).toMatchObject({
      allowed: true,
      rule: "default-allow",
      domain: "safe.example",
      providerConsulted: true,
    });
    expect(decision.verdict?.fromCache).toBe(false);
    expect(counters.hashesSearchRequests).toBe(before);
  });

  it("re-scans on a second lookup without a dedup handle (no verdict cache)", async () => {
    const before = riskyHits();

    const first = await checkUrl(RISKY_DOMAIN, policy(), {});
    const second = await checkUrl(RISKY_DOMAIN, policy(), {});

    expect(first).toMatchObject({ allowed: false, providerConsulted: true });
    expect(second).toMatchObject({ allowed: false, providerConsulted: true });
    expect(second).not.toBe(first);
    // Two independent scans, two confirmation calls — nothing was cached.
    expect(riskyHits()).toBe(before + 2);
  });

  it("shares one in-flight decision within a request via ctx.dedup", async () => {
    const before = riskyHits();
    const dedup: ThreatCheckDedup = new Map();

    // Concurrent + sequential re-checks of the same URL in one request.
    const [first, second] = await Promise.all([
      checkUrl(RISKY_DOMAIN, policy(), { dedup }),
      checkUrl(RISKY_DOMAIN, policy(), { dedup }),
    ]);
    const third = await checkUrl(`http://${RISKY_DOMAIN}./`, policy(), {
      dedup,
    });

    // Same decision object → a single scan → a single consulted decision.
    expect(second).toBe(first);
    expect(third).toBe(first); // URL canonicalization applies before dedup
    expect(riskyHits()).toBe(before + 1);
  });

  it("scans distinct URLs in a dedup scope separately (same domain included)", async () => {
    const dedup: ThreatCheckDedup = new Map();
    const before = riskyHits();

    const clean = await checkUrl("safe.example", policy(), { dedup });
    const risky = await checkUrl(RISKY_DOMAIN, policy(), { dedup });
    const riskyPath = await checkUrl(`http://${RISKY_DOMAIN}/page`, policy(), {
      dedup,
    });

    expect(clean.allowed).toBe(true);
    expect(risky.allowed).toBe(false);
    expect(riskyPath.allowed).toBe(false);
    expect(riskyPath).not.toBe(risky); // different canonical URLs
    // Two independent scans of the same domain: each one confirms the
    // domain's flagged root-expression prefix, and each is its own billable
    // scan (billing dedups on decision.url — see calculateThreatScanCredits).
    expect(riskyHits()).toBe(before + 2);
  });

  it("retries once and succeeds when the first confirmation attempt fails", async () => {
    failHashesSearches = 1; // exactly the first hashes:search attempt 503s

    const decision = await checkUrl(RISKY_DOMAIN, policy(), {});

    expect(decision).toMatchObject({
      allowed: false,
      rule: "risk-score",
      providerConsulted: true,
    });
    expect(failHashesSearches).toBe(0);
  });

  it("fails closed when confirmation is down and failurePolicy is closed", async () => {
    failHashesSearches = Infinity;

    const decision = await checkUrl(
      RISKY_DOMAIN,
      policy({ failurePolicy: "closed" }),
      { teamId: "team-1" },
    );

    expect(decision).toEqual({
      allowed: false,
      rule: "provider-failure",
      url: `http://${RISKY_DOMAIN}/`,
      domain: RISKY_DOMAIN,
      providerConsulted: false,
      verdict: null,
      mode: "normal",
    });
  });

  it("fails open when confirmation is down and failurePolicy is open", async () => {
    failHashesSearches = Infinity;

    const decision = await checkUrl(
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
  it("carries the URL, domain and decision with the unsafe_domain_blocked code", async () => {
    const decision = await checkUrl(
      "https://bad.example/landing",
      policy({ blacklist: ["bad.example"] }),
      {},
    );
    const error = new UnsafeDomainBlockedError(
      "https://bad.example/landing",
      decision,
    );

    expect(error.code).toBe("unsafe_domain_blocked");
    expect(error.name).toBe("UnsafeDomainBlockedError");
    expect(error.url).toBe("https://bad.example/landing");
    expect(error.domain).toBe("bad.example");
    expect(error.decision).toBe(decision);
    expect(error.message).toContain("threat protection policy");
    expect(error.message).toContain("blacklist");
  });
});
