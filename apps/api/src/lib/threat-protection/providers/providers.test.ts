import http from "http";
import { AddressInfo } from "net";
import { config } from "../../../config";
import { fetchAlphaMountainVerdict } from "./alphamountain";
import { fetchGoogleWebRiskVerdict } from "./google-web-risk";

// Mocked-HTTP provider tests: a local http server stands in for the real
// provider APIs via the config URL overrides (same pattern as
// src/lib/fire-privacy-client.test.ts).

type SeenRequest = { url: string; method: string; body: unknown };

let server: http.Server;
let baseUrl: string;
let seenRequests: SeenRequest[] = [];
let routes: Record<string, { status: number; body: unknown }> = {};

const originalConfig = {
  webRiskUrl: config.GOOGLE_WEB_RISK_API_URL,
  webRiskKey: config.GOOGLE_WEB_RISK_API_KEY,
  amUrl: config.ALPHAMOUNTAIN_API_URL,
  amKey: config.ALPHAMOUNTAIN_API_KEY,
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

        const path = (req.url ?? "").split("?")[0];
        const route = routes[path];
        if (!route) {
          res.statusCode = 404;
          res.end("{}");
          return;
        }
        res.statusCode = route.status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(route.body));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      config.GOOGLE_WEB_RISK_API_URL = baseUrl;
      config.GOOGLE_WEB_RISK_API_KEY = "test-web-risk-key";
      config.ALPHAMOUNTAIN_API_URL = baseUrl;
      config.ALPHAMOUNTAIN_API_KEY = "test-am-license";
      resolve();
    });
  });
});

afterAll(async () => {
  config.GOOGLE_WEB_RISK_API_URL = originalConfig.webRiskUrl;
  config.GOOGLE_WEB_RISK_API_KEY = originalConfig.webRiskKey;
  config.ALPHAMOUNTAIN_API_URL = originalConfig.amUrl;
  config.ALPHAMOUNTAIN_API_KEY = originalConfig.amKey;
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => {
  seenRequests = [];
  routes = {};
});

describe("fetchGoogleWebRiskVerdict", () => {
  it("maps a confirmed threat to riskScore 100 with threat-type categories", async () => {
    routes["/v1/uris:search"] = {
      status: 200,
      body: {
        threat: {
          threatTypes: ["MALWARE", "SOCIAL_ENGINEERING"],
          expireTime: "2026-07-04T12:00:00Z",
        },
      },
    };

    const verdict = await fetchGoogleWebRiskVerdict("malware.example");

    expect(verdict).toMatchObject({
      provider: "google-web-risk",
      riskScore: 100,
      categories: ["MALWARE", "SOCIAL_ENGINEERING"],
      domainAgeDays: null,
      countryCode: null,
      fromCache: false,
    });
    expect(verdict.raw).toEqual(routes["/v1/uris:search"].body);

    expect(seenRequests).toHaveLength(1);
    const url = new URL(baseUrl + seenRequests[0].url);
    expect(seenRequests[0].method).toBe("GET");
    expect(url.searchParams.getAll("threatTypes")).toEqual([
      "MALWARE",
      "SOCIAL_ENGINEERING",
      "UNWANTED_SOFTWARE",
    ]);
    expect(url.searchParams.get("uri")).toBe("http://malware.example/");
    expect(url.searchParams.get("key")).toBe("test-web-risk-key");
  });

  it("maps no match to riskScore 0 with no categories", async () => {
    routes["/v1/uris:search"] = { status: 200, body: {} };

    const verdict = await fetchGoogleWebRiskVerdict("safe.example");

    expect(verdict).toMatchObject({
      provider: "google-web-risk",
      riskScore: 0,
      categories: [],
      fromCache: false,
    });
  });

  it("throws on non-2xx responses so failurePolicy can apply", async () => {
    routes["/v1/uris:search"] = { status: 503, body: {} };

    await expect(fetchGoogleWebRiskVerdict("safe.example")).rejects.toThrow(
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

describe("fetchAlphaMountainVerdict", () => {
  it("combines threat, category, and intelligence lookups into a verdict", async () => {
    const registered = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    routes["/threat/uri"] = {
      status: 200,
      body: {
        version: 1,
        status: { threat: "Success" },
        threat: { score: 7.82, scope: "domain", source: "rt" },
        ttl: 28800,
      },
    };
    routes["/category/uri"] = {
      status: 200,
      body: {
        version: 1,
        status: { category: "Success" },
        category: {
          categories: [24, 51, 999],
          scope: "domain",
          confidence: 0.9,
        },
        ttl: 28800,
      },
    };
    routes["/intelligence/hostname"] = {
      status: 200,
      body: {
        version: 1,
        status: { whois: "Success", geo: "Success" },
        // Mirrors the live /intelligence/hostname response shape
        // (verified against the real API 2026-07-05): whois fields are
        // top-level, geo nests per-address-family arrays with `isoCode`.
        sections: {
          whois: {
            domain: "risky.example",
            created: registered.toISOString(),
            updated: registered.toISOString(),
            registrar: "Test Registrar Inc.",
            private: false,
          },
          geo: {
            ipv4: [
              {
                ip: "203.0.113.7",
                latLng: [55.75, 37.61],
                city: null,
                country: "Russia",
                isoCode: "RU",
                asn: { number: 64496, organization: "Test AS" },
                traits: null,
                rating: 3.1,
              },
            ],
            ipv6: [],
            ns: [],
          },
        },
        errors: {},
      },
    };

    const verdict = await fetchAlphaMountainVerdict("risky.example");

    expect(verdict).toMatchObject({
      provider: "alphamountain",
      // 7.82 on alphaMountain's 0-10 scale → 78 on the normalized 0-100 scale
      riskScore: 78,
      categories: ["Gambling", "Phishing", "category-999"],
      countryCode: "RU",
      fromCache: false,
    });
    expect(verdict.domainAgeDays).toBe(10);

    expect(seenRequests).toHaveLength(3);
    const byPath = Object.fromEntries(
      seenRequests.map(r => [r.url.split("?")[0], r.body as any]),
    );
    expect(byPath["/threat/uri"]).toMatchObject({
      version: 1,
      license: "test-am-license",
      type: "partner.info",
      uri: "http://risky.example/",
    });
    expect(byPath["/category/uri"]).toMatchObject({
      version: 1,
      license: "test-am-license",
      uri: "http://risky.example/",
    });
    expect(byPath["/intelligence/hostname"]).toMatchObject({
      version: 1,
      license: "test-am-license",
      hostname: "risky.example",
      sections: ["whois", "geo"],
    });
  });

  it("throws on a semantic failure inside an HTTP 200 body", async () => {
    // e.g. quota/license errors are reported via status.* with HTTP 200 —
    // they must route into retry/failurePolicy, not read as a benign verdict.
    routes["/threat/uri"] = {
      status: 200,
      body: { version: 1, status: { threat: "License Limit Exceeded" } },
    };
    routes["/category/uri"] = {
      status: 200,
      body: {
        version: 1,
        status: { category: "Success" },
        category: { categories: [45] },
      },
    };
    routes["/intelligence/hostname"] = {
      status: 200,
      body: { version: 1, sections: {} },
    };

    await expect(fetchAlphaMountainVerdict("quota.example")).rejects.toThrow(
      /threat lookup returned status/,
    );

    routes["/threat/uri"] = {
      status: 200,
      body: { version: 1, status: { threat: "Success" }, threat: { score: 1 } },
    };
    routes["/category/uri"] = {
      status: 200,
      body: { version: 1, status: { category: "Unauthorized" } },
    };

    await expect(fetchAlphaMountainVerdict("quota.example")).rejects.toThrow(
      /category lookup returned status/,
    );
  });

  it("returns a null riskScore when the threat rating is Not Found", async () => {
    routes["/threat/uri"] = {
      status: 200,
      body: { version: 1, status: { threat: "Not Found" }, ttl: 60 },
    };
    routes["/category/uri"] = {
      status: 200,
      body: {
        version: 1,
        status: { category: "Success" },
        category: { categories: [45] },
      },
    };
    routes["/intelligence/hostname"] = {
      status: 200,
      body: { version: 1, sections: {} },
    };

    const verdict = await fetchAlphaMountainVerdict("unknown.example");

    expect(verdict.riskScore).toBeNull();
    expect(verdict.categories).toEqual(["News"]);
    expect(verdict.domainAgeDays).toBeNull();
    expect(verdict.countryCode).toBeNull();
  });

  it("clamps out-of-range threat scores to 0-100", async () => {
    routes["/threat/uri"] = {
      status: 200,
      body: { status: { threat: "Success" }, threat: { score: 12.5 } },
    };
    routes["/category/uri"] = {
      status: 200,
      body: { status: { category: "Success" }, category: { categories: [] } },
    };
    routes["/intelligence/hostname"] = {
      status: 200,
      body: { sections: {} },
    };

    const verdict = await fetchAlphaMountainVerdict("weird.example");
    expect(verdict.riskScore).toBe(100);
  });

  it("still produces a verdict when only the intelligence call fails", async () => {
    routes["/threat/uri"] = {
      status: 200,
      body: { status: { threat: "Success" }, threat: { score: 1.0 } },
    };
    routes["/category/uri"] = {
      status: 200,
      body: { status: { category: "Success" }, category: { categories: [64] } },
    };
    routes["/intelligence/hostname"] = { status: 500, body: {} };

    const verdict = await fetchAlphaMountainVerdict("partial.example");

    expect(verdict).toMatchObject({
      riskScore: 10,
      categories: ["Search Engines/Portals"],
      domainAgeDays: null,
      countryCode: null,
    });
  });

  it("throws when the threat lookup fails so failurePolicy can apply", async () => {
    routes["/threat/uri"] = { status: 429, body: {} };
    routes["/category/uri"] = {
      status: 200,
      body: { status: { category: "Success" }, category: { categories: [] } },
    };
    routes["/intelligence/hostname"] = { status: 200, body: { sections: {} } };

    await expect(fetchAlphaMountainVerdict("quota.example")).rejects.toThrow(
      /status 429/,
    );
  });

  it("throws when the category lookup fails so failurePolicy can apply", async () => {
    routes["/threat/uri"] = {
      status: 200,
      body: { status: { threat: "Success" }, threat: { score: 0.5 } },
    };
    routes["/category/uri"] = { status: 503, body: {} };
    routes["/intelligence/hostname"] = { status: 200, body: { sections: {} } };

    await expect(fetchAlphaMountainVerdict("nocat.example")).rejects.toThrow(
      /status 503/,
    );
  });

  it("throws when the license key is not configured", async () => {
    config.ALPHAMOUNTAIN_API_KEY = undefined;
    try {
      await expect(fetchAlphaMountainVerdict("safe.example")).rejects.toThrow(
        /not configured/,
      );
    } finally {
      config.ALPHAMOUNTAIN_API_KEY = "test-am-license";
    }
    expect(seenRequests).toHaveLength(0);
  });
});
