import http from "http";
import { config } from "../../../../config";
import {
  toLookupUrl,
  ZscalerError,
  zscalerGetUrlCategories,
  zscalerLookupUrls,
  zscalerTestConnection,
  type ZscalerCredentials,
} from "./client";
import {
  createZscalerMockCounters,
  createZscalerMockHandler,
  type ZscalerMockDatabase,
} from "./testing";

const counters = createZscalerMockCounters();
const db: ZscalerMockDatabase = {
  clientId: "test-client",
  clientSecret: "test-secret",
  categories: [
    { id: "GAMBLING" },
    {
      id: "CUSTOM_01",
      configuredName: "Blocked Vendors",
      customCategory: true,
      urls: ["vendor.example.com"],
    },
  ],
  classifications: {
    "casino.example.com": {
      urlClassifications: ["GAMBLING"],
      urlClassificationsWithSecurityAlert: [],
    },
    "malware.example.com": {
      urlClassifications: [],
      urlClassificationsWithSecurityAlert: ["MALWARE_SITE"],
    },
  },
};

let server: http.Server;
let originalTokenOverride: string | undefined;
let originalApiOverride: string | undefined;

function credentials(
  overrides: Partial<ZscalerCredentials> = {},
): ZscalerCredentials {
  return {
    clientId: "test-client",
    clientSecret: "test-secret",
    vanityDomain: "testtenant",
    cloud: null,
    ...overrides,
  };
}

beforeAll(async () => {
  server = http.createServer(createZscalerMockHandler(db, counters));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address !== "object") {
    throw new Error("Mock server did not bind");
  }
  const base = `http://127.0.0.1:${address.port}`;
  originalTokenOverride = config.ZSCALER_TOKEN_URL_OVERRIDE;
  originalApiOverride = config.ZSCALER_API_URL_OVERRIDE;
  config.ZSCALER_TOKEN_URL_OVERRIDE = `${base}/oauth2/v1/token`;
  config.ZSCALER_API_URL_OVERRIDE = base;
});

afterAll(async () => {
  config.ZSCALER_TOKEN_URL_OVERRIDE = originalTokenOverride;
  config.ZSCALER_API_URL_OVERRIDE = originalApiOverride;
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
  db.denyLookupScope = false;
  db.rateLimitLookups = false;
});

describe("zscalerLookupUrls", () => {
  it("classifies a batch and normalizes the response", async () => {
    const results = await zscalerLookupUrls(credentials(), [
      "casino.example.com",
      "malware.example.com",
      "unknown.example.com",
    ]);
    expect(results).toEqual([
      {
        url: "casino.example.com",
        urlClassifications: ["GAMBLING"],
        urlClassificationsWithSecurityAlert: [],
      },
      {
        url: "malware.example.com",
        urlClassifications: [],
        urlClassificationsWithSecurityAlert: ["MALWARE_SITE"],
      },
      {
        url: "unknown.example.com",
        urlClassifications: ["MISCELLANEOUS_OR_UNKNOWN"],
        urlClassificationsWithSecurityAlert: [],
      },
    ]);
  });

  it("reuses the cached token across calls", async () => {
    // Prime the cache explicitly instead of relying on test order.
    await zscalerLookupUrls(credentials(), ["casino.example.com"]);
    const tokenCallsBefore = counters.tokenCalls;
    await zscalerLookupUrls(credentials(), ["casino.example.com"]);
    await zscalerLookupUrls(credentials(), ["casino.example.com"]);
    expect(counters.tokenCalls).toBe(tokenCallsBefore);
  });

  it("refuses more than 100 URLs per call", async () => {
    const urls = Array.from({ length: 101 }, (_, i) => `u${i}.example.com`);
    await expect(zscalerLookupUrls(credentials(), urls)).rejects.toMatchObject({
      kind: "api",
    });
  });

  it("maps a tenant-side 429 to a rate-limit error with Retry-After", async () => {
    db.rateLimitLookups = true;
    let caught: unknown;
    try {
      await zscalerLookupUrls(credentials(), ["casino.example.com"]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ZscalerError);
    expect(caught).toMatchObject({ kind: "rate-limit", status: 429 });
    expect((caught as ZscalerError).retryAfterMs).toBeGreaterThan(0);
  });
});

describe("authentication errors", () => {
  it("maps rejected credentials to an auth error", async () => {
    await expect(
      zscalerGetUrlCategories(credentials({ clientSecret: "wrong-secret" })),
    ).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("zscalerTestConnection", () => {
  it("passes all three stages with a full-access client", async () => {
    const result = await zscalerTestConnection(credentials());
    expect(result).toMatchObject({
      ok: true,
      tokenOk: true,
      categoriesOk: true,
      lookupOk: true,
      categoryCount: 2,
      error: null,
    });
  });

  it("distinguishes bad credentials from a scope problem", async () => {
    const badCredentials = await zscalerTestConnection(
      credentials({ clientSecret: "wrong-secret" }),
    );
    expect(badCredentials).toMatchObject({
      ok: false,
      tokenOk: false,
      error: { kind: "auth" },
    });

    // View Only-style role: taxonomy reads fine, the lookup probe is denied.
    db.denyLookupScope = true;
    const scopeProblem = await zscalerTestConnection(credentials());
    expect(scopeProblem).toMatchObject({
      ok: false,
      tokenOk: true,
      categoriesOk: true,
      lookupOk: false,
      error: { kind: "scope" },
    });
  });
});

describe("toLookupUrl", () => {
  test.each([
    ["https://Example.com/Path?q=1#frag", "example.com/Path?q=1"],
    ["http://example.com/", "example.com"],
    ["example.com", "example.com"],
    ["https://example.com:8080/x", "example.com:8080/x"],
  ])("shapes %s into %s", (input, expected) => {
    expect(toLookupUrl(input)).toBe(expected);
  });

  it("rejects entries over the ZIA limit instead of truncating them", () => {
    const long = `example.com/${"a".repeat(2000)}`;
    // Truncating would classify a different URL; the failurePolicy decides.
    expect(() => toLookupUrl(long)).toThrow(ZscalerError);
  });
});
