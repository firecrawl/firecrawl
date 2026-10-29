import http from "http";
import { AddressInfo } from "net";

// The Web Risk threat-list store lives on the durable Redis connection —
// swap in an in-memory fake. (fake-redis.ts has no runtime imports, so the
// factory cannot re-enter the module being mocked.)
vi.mock("../../../services/queue-service", async () => {
  const { createFakeWebRiskRedis } = await import("./web-risk/fake-redis.js");
  const client = createFakeWebRiskRedis();
  return { getRedisConnection: () => client };
});

import { config } from "../../../config";
import { fetchGoogleWebRiskVerdict } from "./google-web-risk";
import { urlExpressionHash, WebRiskMockDatabase } from "./web-risk/testing";

// Mocked-HTTP provider tests: a local http server stands in for the real
// provider API via the config URL override (same pattern as
// src/lib/fire-privacy-client.test.ts). For Google Web Risk the mock serves
// the Update API endpoints (threatLists:computeDiff + hashes:search); the
// old uris:search endpoint intentionally no longer exists.

type SeenRequest = { url: string; method: string; body: unknown };

let server: http.Server;
let baseUrl: string;
let seenRequests: SeenRequest[] = [];

// Fixture threat lists, fixed for the whole file (the local list is synced
// once per process by the provider's boot sync).
const CONFIRMED_DOMAIN = "malware.example";
const COLLISION_DOMAIN = "collision.example";
// URL-level listing: only this exact page is flagged, its domain is clean.
const CONFIRMED_URL = "http://mostly-clean.example/landing/phishing-page.html";

const webRiskDb = new WebRiskMockDatabase();
webRiskDb.addRiskyDomain(CONFIRMED_DOMAIN, "MALWARE");
webRiskDb.addRiskyDomain(CONFIRMED_DOMAIN, "SOCIAL_ENGINEERING");
webRiskDb.addRiskyUrl(CONFIRMED_URL, "SOCIAL_ENGINEERING");
// A list entry that shares the 4-byte prefix of COLLISION_DOMAIN's expression
// hash but is a different full hash → local hit, unconfirmed by hashes:search.
webRiskDb.addCollidingFullHash(
  Buffer.concat([
    urlExpressionHash(COLLISION_DOMAIN).subarray(0, 4),
    Buffer.alloc(28, 0xab),
  ]),
  "UNWANTED_SOFTWARE",
);

// While > 0, hashes:search requests fail with 503 (decremented per request).
let failHashesSearches = 0;

const originalConfig = {
  webRiskUrl: config.GOOGLE_WEB_RISK_API_URL,
  webRiskKey: config.GOOGLE_WEB_RISK_API_KEY,
};

beforeAll(async () => {
  await new Promise<void>(resolve => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", chunk => chunks.push(chunk));
      req.on("end", () => {
        const rawBody = Buffer.concat(chunks).toString("utf8");
        let body: unknown = null;
        try {
          body = rawBody ? JSON.parse(rawBody) : null;
        } catch {}
        seenRequests.push({
          url: req.url ?? "",
          method: req.method ?? "",
          body,
        });

        const url = new URL(req.url ?? "/", "http://localhost");
        const path = url.pathname;

        // Web Risk Update API endpoints.
        if (path === "/v1/threatLists:computeDiff") {
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify(
              webRiskDb.computeDiffResponse(
                url.searchParams.get("threatType") ?? "",
              ),
            ),
          );
          return;
        }
        if (path === "/v1/hashes:search") {
          if (failHashesSearches > 0) {
            failHashesSearches--;
            res.statusCode = 503;
            res.end("{}");
            return;
          }
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify(
              webRiskDb.hashesSearchResponse(
                url.searchParams.get("hashPrefix") ?? "",
              ),
            ),
          );
          return;
        }

        res.statusCode = 404;
        res.end("{}");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      config.GOOGLE_WEB_RISK_API_URL = baseUrl;
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
  seenRequests = [];
  failHashesSearches = 0;
});

const hashesSearchRequests = () =>
  seenRequests.filter(r => r.url.startsWith("/v1/hashes:search"));
const urisSearchRequests = () =>
  seenRequests.filter(r => r.url.startsWith("/v1/uris:search"));

describe("fetchGoogleWebRiskVerdict", () => {
  it("confirms a local prefix hit via hashes:search → riskScore 100 with categories", async () => {
    const verdict = await fetchGoogleWebRiskVerdict(CONFIRMED_DOMAIN);

    expect(verdict).toMatchObject({
      provider: "google-web-risk",
      riskScore: 100,
      fromCache: false,
    });
    expect([...verdict.categories].sort()).toEqual([
      "MALWARE",
      "SOCIAL_ENGINEERING",
    ]);

    // Exactly one confirmation call, carrying ONLY the anonymized 4-byte
    // hash prefix (never the domain or URL), plus the API key.
    const confirmations = hashesSearchRequests();
    expect(confirmations).toHaveLength(1);
    const url = new URL(baseUrl + confirmations[0].url);
    expect(confirmations[0].method).toBe("GET");
    expect(url.searchParams.get("hashPrefix")).toBe(
      urlExpressionHash(CONFIRMED_DOMAIN).subarray(0, 4).toString("base64"),
    );
    expect(url.searchParams.getAll("threatTypes")).toEqual([
      "MALWARE",
      "SOCIAL_ENGINEERING",
      "UNWANTED_SOFTWARE",
    ]);
    expect(url.searchParams.get("key")).toBe("test-web-risk-key");
    expect(confirmations[0].url).not.toContain(CONFIRMED_DOMAIN);
    // The legacy full-URL lookup endpoint is never used.
    expect(urisSearchRequests()).toHaveLength(0);
  });

  it("flags subdomains of a listed domain through host-suffix expressions", async () => {
    const verdict = await fetchGoogleWebRiskVerdict(
      `cdn.assets.${CONFIRMED_DOMAIN}`,
    );

    expect(verdict.riskScore).toBe(100);
    expect(verdict.categories).toContain("MALWARE");
  });

  it("flags every URL on a listed domain through host-suffix expressions", async () => {
    const verdict = await fetchGoogleWebRiskVerdict(
      `https://${CONFIRMED_DOMAIN}/some/deep/page.html?q=1`,
    );

    expect(verdict.riskScore).toBe(100);
    expect(verdict.categories).toContain("MALWARE");
  });

  it("flags a listed URL whose domain is otherwise clean", async () => {
    const verdict = await fetchGoogleWebRiskVerdict(CONFIRMED_URL);

    expect(verdict.riskScore).toBe(100);
    expect(verdict.categories).toEqual(["SOCIAL_ENGINEERING"]);
  });

  it("keeps other URLs on that domain clean (URL-level, not domain-level)", async () => {
    const siblingPage = await fetchGoogleWebRiskVerdict(
      "http://mostly-clean.example/landing/legit-page.html",
    );
    const root = await fetchGoogleWebRiskVerdict(
      "http://mostly-clean.example/",
    );

    expect(siblingPage.riskScore).toBe(0);
    expect(root.riskScore).toBe(0);
    expect(hashesSearchRequests()).toHaveLength(0);
  });

  it("resolves clean domains locally with zero Google calls", async () => {
    const verdict = await fetchGoogleWebRiskVerdict("safe.example");

    expect(verdict).toMatchObject({
      provider: "google-web-risk",
      riskScore: 0,
      categories: [],
      fromCache: false,
      raw: { localPrefixMatch: false },
    });
    // The common case transmits nothing: no hashes:search, no uris:search.
    expect(hashesSearchRequests()).toHaveLength(0);
    expect(urisSearchRequests()).toHaveLength(0);
  });

  it("treats an unconfirmed prefix hit (collision) as clean", async () => {
    const verdict = await fetchGoogleWebRiskVerdict(COLLISION_DOMAIN);

    expect(verdict).toMatchObject({
      provider: "google-web-risk",
      riskScore: 0,
      categories: [],
    });
    // The collision DID require a confirmation round trip…
    expect(hashesSearchRequests()).toHaveLength(1);
    // …whose returned full hash didn't match any of our expression hashes.
    expect(verdict.raw).toMatchObject({ localPrefixMatch: true });
  });

  it("throws on hashes:search errors so failurePolicy can apply", async () => {
    failHashesSearches = Infinity;

    await expect(fetchGoogleWebRiskVerdict(CONFIRMED_DOMAIN)).rejects.toThrow(
      /status 503/,
    );
  });

  it("throws when the API key is not configured", async () => {
    config.GOOGLE_WEB_RISK_API_KEY = undefined;
    try {
      await expect(fetchGoogleWebRiskVerdict("safe.example")).rejects.toThrow(
        /not configured/,
      );
    } finally {
      config.GOOGLE_WEB_RISK_API_KEY = "test-web-risk-key";
    }
    expect(seenRequests).toHaveLength(0);
  });
});
