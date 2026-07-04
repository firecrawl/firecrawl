import http from "http";
import { AddressInfo } from "net";

// In-memory Redis stand-in so importing the cache doesn't dial a real Redis.
const redisStore = new Map<string, string>();
vi.mock("../../services/rate-limiter", () => ({
  redisRateLimitClient: {
    get: vi.fn(async (key: string) => redisStore.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      redisStore.set(key, value);
      return "OK";
    }),
  },
}));

// checkDomain emits security events (see logging.ts) — stub the sinks so this
// suite doesn't touch ClickHouse, the SIEM buffer, or Postgres (org lookup).
vi.mock("../tracking", () => ({
  trackThreatProtectionCheck: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../services/webhook/siem", () => ({
  enqueueSiemThreatEvent: vi.fn(),
}));
vi.mock("./store", () => ({
  getOrgIdForTeam: vi.fn().mockResolvedValue(null),
}));

import { config } from "../../config";
import {
  checkDomain,
  THREAT_PROTECTION_POLICY_DEFAULTS,
  ThreatProtectionPolicy,
  UnsafeDomainBlockedError,
} from "./index";

function policy(
  overrides: Partial<ThreatProtectionPolicy> = {},
): ThreatProtectionPolicy {
  return {
    mode: "normal",
    ...THREAT_PROTECTION_POLICY_DEFAULTS,
    ...overrides,
  };
}

let server: http.Server;
let requestCount = 0;
let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void = (
  _req,
  res,
) => {
  res.statusCode = 500;
  res.end("{}");
};

const originalConfig = {
  webRiskUrl: config.GOOGLE_WEB_RISK_API_URL,
  webRiskKey: config.GOOGLE_WEB_RISK_API_KEY,
};

beforeAll(async () => {
  await new Promise<void>(resolve => {
    server = http.createServer((req, res) => {
      requestCount++;
      handler(req, res);
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
  redisStore.clear();
  requestCount = 0;
  handler = (_req, res) => {
    res.statusCode = 500;
    res.end("{}");
  };
});

function respondWith(body: unknown, status = 200) {
  handler = (_req, res) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };
}

describe("checkDomain", () => {
  it("allows immediately when mode is off, with no provider call", async () => {
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
    expect(requestCount).toBe(0);
  });

  it("skips the paid provider call when a local rule is decisive", async () => {
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
    expect(requestCount).toBe(0);
  });

  it("consults the provider, caches the verdict, and bills on the fresh call", async () => {
    respondWith({ threat: { threatTypes: ["MALWARE"] } });

    const decision = await checkDomain("Malware.Example", policy(), {
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
    expect(requestCount).toBe(1);
    // Verdict cached under the normalized (domain, mode) key.
    expect(
      redisStore.has("threat_protection_verdict:normal:malware.example"),
    ).toBe(true);
  });

  it("serves the second lookup from cache (fromCache, still billed)", async () => {
    respondWith({});

    const first = await checkDomain("safe.example", policy(), {});
    expect(first).toMatchObject({ allowed: true, rule: "default-allow" });
    expect(first.verdict?.fromCache).toBe(false);
    expect(requestCount).toBe(1);

    const second = await checkDomain("safe.example", policy(), {});
    expect(second).toMatchObject({
      allowed: true,
      rule: "default-allow",
      providerConsulted: true,
    });
    expect(second.verdict?.fromCache).toBe(true);
    expect(requestCount).toBe(1); // no additional provider call
  });

  it("retries once and succeeds when the first provider attempt fails", async () => {
    handler = (_req, res) => {
      res.statusCode = requestCount === 1 ? 503 : 200;
      res.setHeader("content-type", "application/json");
      res.end("{}");
    };

    const decision = await checkDomain("flaky.example", policy(), {});

    expect(decision).toMatchObject({
      allowed: true,
      rule: "default-allow",
      providerConsulted: true,
    });
    expect(requestCount).toBe(2);
  });

  it("fails closed when the provider is down and failurePolicy is closed", async () => {
    respondWith({}, 503);

    const decision = await checkDomain(
      "down.example",
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
    expect(requestCount).toBe(2); // initial attempt + 1 retry
  });

  it("fails open when the provider is down and failurePolicy is open", async () => {
    respondWith({}, 503);

    const decision = await checkDomain(
      "down.example",
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

  it("treats a corrupt cache entry as a miss", async () => {
    redisStore.set("threat_protection_verdict:normal:safe.example", "{nope");
    respondWith({});

    const decision = await checkDomain("safe.example", policy(), {});

    expect(decision).toMatchObject({ allowed: true, rule: "default-allow" });
    expect(requestCount).toBe(1);
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
