import { fetch } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../config";
import {
  canUseExchangeForRequest,
  clearExchangeProvidersForTest,
  reportExchangeBilling,
  getExchangeAccessForRequest,
  getExchangeRequestLogContext,
  getExchangeResponseLogContext,
  getExchangeSuccessCredits,
  getThirdPartyDataTermsRequiredResponse,
  isSuccessfulExchangeStatusCode,
  isSupportedExchangeFormatRequest,
  resolveExchangeProvider,
  setExchangeProvidersForTest,
} from "./exchange";

vi.mock("undici", () => ({
  fetch: vi.fn(),
}));

const originalConfig = {
  FIRE_EXCHANGE_URL: config.FIRE_EXCHANGE_URL,
  USE_DB_AUTHENTICATION: config.USE_DB_AUTHENTICATION,
};

const ACME_TERMS = { key: "acme", version: "2026-01-01" };

const TEST_PROVIDERS = [
  {
    id: "acme",
    creditsCost: 12,
    terms: ACME_TERMS,
    routes: [
      {
        domains: ["profiles.example", "www.profiles.example"],
        pathPrefixes: ["/person/", "/company/"],
      },
    ],
  },
  {
    id: "openfacts",
    creditsCost: 0,
    routes: [{ domains: ["facts.example"] }],
  },
];

const ENABLED_EXCHANGE_FLAGS = {
  professionalProfileCompanyDataBeta: true,
  organizationDataSourceAccess: {
    acme: {
      status: "enabled",
      termsKey: "acme",
      termsVersion: "2026-01-01",
      termsAcceptedAt: "2026-01-01T00:00:00.000Z",
      enabledAt: "2026-01-01T00:00:00.000Z",
      disabledAt: null,
      disabledReason: null,
    },
  },
};

describe("Exchange routing", () => {
  beforeEach(() => {
    vi.mocked(fetch).mockReset();
    config.FIRE_EXCHANGE_URL = "https://exchange.example";
    config.USE_DB_AUTHENTICATION = true;
    setExchangeProvidersForTest(TEST_PROVIDERS);
  });

  afterEach(() => {
    config.FIRE_EXCHANGE_URL = originalConfig.FIRE_EXCHANGE_URL;
    config.USE_DB_AUTHENTICATION = originalConfig.USE_DB_AUTHENTICATION;
    clearExchangeProvidersForTest();
  });

  it("resolves URLs to providers using catalog routes", async () => {
    await expect(
      resolveExchangeProvider(
        "https://profiles.example/person/example-person/details/?trk=foo",
      ),
    ).resolves.toMatchObject({ id: "acme", creditsCost: 12 });
    await expect(
      resolveExchangeProvider("https://www.profiles.example/company/example"),
    ).resolves.toMatchObject({ id: "acme" });
    await expect(
      resolveExchangeProvider("https://facts.example/any/path"),
    ).resolves.toMatchObject({ id: "openfacts" });
    await expect(
      resolveExchangeProvider("https://profiles.example/jobs/example"),
    ).resolves.toBeNull();
    await expect(
      resolveExchangeProvider("https://other.example/person/example"),
    ).resolves.toBeNull();
    await expect(resolveExchangeProvider("not a url")).resolves.toBeNull();

    await expect(
      resolveExchangeProvider("https://profiles.example/person/example-person"),
    ).resolves.not.toBeNull();
  });

  it("respects path segment boundaries for prefixes without trailing slashes", async () => {
    setExchangeProvidersForTest([
      {
        id: "acme",
        creditsCost: 12,
        routes: [{ domains: ["profiles.example"], pathPrefixes: ["/person"] }],
      },
    ]);

    await expect(
      resolveExchangeProvider("https://profiles.example/person"),
    ).resolves.toMatchObject({ id: "acme" });
    await expect(
      resolveExchangeProvider("https://profiles.example/person/example"),
    ).resolves.toMatchObject({ id: "acme" });
    await expect(
      resolveExchangeProvider("https://profiles.example/personality/details"),
    ).resolves.toBeNull();
    await expect(
      resolveExchangeProvider("https://profiles.example/personnel"),
    ).resolves.toBeNull();
  });

  it("serves the stale catalog while refreshing in the background", async () => {
    setExchangeProvidersForTest(TEST_PROVIDERS, -1);
    let resolveFetch: (value: unknown) => void = () => {};
    vi.mocked(fetch).mockReturnValue(
      new Promise(resolve => {
        resolveFetch = resolve;
      }) as ReturnType<typeof fetch>,
    );

    // The catalog is expired and the refresh never resolves during the
    // request - the stale value must be served without waiting.
    await expect(
      resolveExchangeProvider("https://profiles.example/person/example"),
    ).resolves.toMatchObject({ id: "acme" });
    expect(fetch).toHaveBeenCalledTimes(1);

    resolveFetch({ ok: false, status: 503 });
  });

  it("keeps serving the last good catalog when a refresh fails", async () => {
    setExchangeProvidersForTest(TEST_PROVIDERS, -1);
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 503,
    } as Awaited<ReturnType<typeof fetch>>);

    await expect(
      resolveExchangeProvider("https://profiles.example/person/example"),
    ).resolves.toMatchObject({ id: "acme" });

    // Let the background refresh settle - the failure must not clobber
    // the catalog, and the failure TTL must throttle the next attempt.
    await new Promise(resolve => setTimeout(resolve, 0));
    await expect(
      resolveExchangeProvider("https://profiles.example/person/example"),
    ).resolves.toMatchObject({ id: "acme" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("degrades to ineligible when the access check itself throws", async () => {
    const explodingFlags = new Proxy(
      {},
      {
        get() {
          throw new Error("flags backend exploded");
        },
      },
    ) as { professionalProfileCompanyDataBeta?: boolean };

    await expect(
      getExchangeAccessForRequest({
        url: "https://profiles.example/person/example-person",
        formats: [{ type: "markdown" }],
        flags: explodingFlags,
      }),
    ).resolves.toEqual({ allowed: false, termsRequired: false });
  });

  it("caches failed provider catalog lookups briefly", async () => {
    clearExchangeProvidersForTest();
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 503,
    } as Awaited<ReturnType<typeof fetch>>);

    await expect(
      resolveExchangeProvider("https://profiles.example/person/example-person"),
    ).resolves.toBeNull();
    await expect(
      resolveExchangeProvider("https://profiles.example/person/example-person"),
    ).resolves.toBeNull();

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("parses the provider catalog response", async () => {
    clearExchangeProvidersForTest();
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: [
          {
            id: "acme",
            name: "Acme",
            description: "Structured records.",
            creditsCost: 12,
            terms: ACME_TERMS,
            capabilities: {
              scrape: {
                resourceTypes: ["records"],
                includes: [],
                urlRoutes: [
                  {
                    domains: ["Profiles.Example"],
                    pathPrefixes: ["person/"],
                  },
                ],
              },
            },
          },
          {
            id: "searchonly",
            name: "Search Only",
            description: "No scrape routes.",
            creditsCost: 0,
            capabilities: { search: { modes: ["semantic"] } },
          },
        ],
      }),
    } as unknown as Awaited<ReturnType<typeof fetch>>);

    await expect(
      resolveExchangeProvider("https://profiles.example/person/example"),
    ).resolves.toMatchObject({ id: "acme", terms: ACME_TERMS });
    await expect(
      resolveExchangeProvider("https://searchonly.example/anything"),
    ).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("builds a compact request log context", () => {
    expect(
      getExchangeRequestLogContext(
        "https://profiles.example/person/example-person/details/?trk=foo",
      ),
    ).toEqual({
      url: "https://profiles.example/person/example-person/details/?trk=foo",
      host: "profiles.example",
      pathPrefix: "person",
    });

    expect(getExchangeRequestLogContext("not a url")).toBeUndefined();

    // Embedded credentials must never reach the logs.
    expect(
      getExchangeRequestLogContext(
        "https://user:secret@profiles.example/person/example",
      ),
    ).toEqual({
      url: "https://profiles.example/person/example",
      host: "profiles.example",
      pathPrefix: "person",
    });
  });

  it("extracts response cache metadata for logs", () => {
    expect(
      getExchangeResponseLogContext({
        cacheState: "hit",
        cachedAt: "2026-06-21T10:00:00.000Z",
        cacheAgeMs: 1000,
        request_id: "req_123",
        extra: "ignored",
      }),
    ).toEqual({
      cacheState: "hit",
      cachedAt: "2026-06-21T10:00:00.000Z",
      cacheAgeMs: 1000,
      providerRequestId: "req_123",
    });

    expect(getExchangeResponseLogContext(null)).toEqual({});
  });

  it("accepts only formats the Exchange can return directly", () => {
    expect(isSupportedExchangeFormatRequest(undefined)).toBe(true);
    expect(isSupportedExchangeFormatRequest([{ type: "markdown" }])).toBe(
      true,
    );
    expect(isSupportedExchangeFormatRequest(["json"])).toBe(true);
    expect(
      isSupportedExchangeFormatRequest([
        { type: "markdown" },
        { type: "json" },
      ]),
    ).toBe(true);
    expect(isSupportedExchangeFormatRequest([{ type: "html" }])).toBe(false);
    // deterministicJson extractors run against page HTML, which Exchange
    // responses do not carry.
    expect(isSupportedExchangeFormatRequest([{ type: "deterministicJson" }])).toBe(
      false,
    );
    expect(isSupportedExchangeFormatRequest([])).toBe(false);
  });

  it("allows eligible requests when access and terms are current", async () => {
    await expect(
      getExchangeAccessForRequest({
        url: "https://profiles.example/person/example-person",
        formats: [{ type: "markdown" }],
        flags: ENABLED_EXCHANGE_FLAGS,
      }),
    ).resolves.toMatchObject({
      allowed: true,
      provider: { id: "acme", creditsCost: 12 },
    });

    await expect(
      canUseExchangeForRequest({
        url: "https://profiles.example/person/example-person",
        formats: [{ type: "json" }],
        actions: [{ type: "wait" }],
        flags: ENABLED_EXCHANGE_FLAGS,
      }),
    ).resolves.toBe(false);

    await expect(
      canUseExchangeForRequest({
        url: "https://profiles.example/person/example-person",
        formats: [{ type: "json" }],
        zeroDataRetention: true,
        flags: ENABLED_EXCHANGE_FLAGS,
      }),
    ).resolves.toBe(false);

    // Profile-backed scrapes expect session-specific content.
    await expect(
      canUseExchangeForRequest({
        url: "https://profiles.example/person/example-person",
        formats: [{ type: "markdown" }],
        profile: { id: "profile-1" },
        flags: ENABLED_EXCHANGE_FLAGS,
      }),
    ).resolves.toBe(false);

    // atsv requests stay on engines that support the flag.
    await expect(
      canUseExchangeForRequest({
        url: "https://profiles.example/person/example-person",
        formats: [{ type: "markdown" }],
        atsv: true,
        flags: ENABLED_EXCHANGE_FLAGS,
      }),
    ).resolves.toBe(false);

    // minAge asks for Firecrawl-cached data, which the Exchange never has.
    await expect(
      canUseExchangeForRequest({
        url: "https://profiles.example/person/example-person",
        formats: [{ type: "markdown" }],
        minAge: 3_600_000,
        flags: ENABLED_EXCHANGE_FLAGS,
      }),
    ).resolves.toBe(false);

    // Selector-based filtering does not apply to provider records.
    await expect(
      canUseExchangeForRequest({
        url: "https://profiles.example/person/example-person",
        formats: [{ type: "markdown" }],
        includeTags: ["article"],
        flags: ENABLED_EXCHANGE_FLAGS,
      }),
    ).resolves.toBe(false);
    await expect(
      canUseExchangeForRequest({
        url: "https://profiles.example/person/example-person",
        formats: [{ type: "markdown" }],
        excludeTags: ["nav"],
        flags: ENABLED_EXCHANGE_FLAGS,
      }),
    ).resolves.toBe(false);
  });

  it("requires the provider's terms before routing", async () => {
    const access = await getExchangeAccessForRequest({
      url: "https://profiles.example/person/example-person",
      formats: [{ type: "markdown" }],
      flags: { professionalProfileCompanyDataBeta: true },
    });

    expect(access).toEqual({
      allowed: false,
      termsRequired: true,
      terms: ACME_TERMS,
    });

    expect(getThirdPartyDataTermsRequiredResponse(ACME_TERMS)).toMatchObject({
      success: false,
      code: "THIRD_PARTY_DATA_TERMS_REQUIRED",
      requiresAction: {
        type: "accept_terms",
        terms: "acme",
        version: "2026-01-01",
      },
    });
  });

  it("requires current terms when the accepted version is stale", async () => {
    await expect(
      getExchangeAccessForRequest({
        url: "https://profiles.example/person/example-person",
        formats: [{ type: "markdown" }],
        flags: {
          professionalProfileCompanyDataBeta: true,
          organizationDataSourceAccess: {
            acme: {
              status: "enabled",
              termsKey: "acme",
              termsVersion: "2025-12-01",
            },
          },
        },
      }),
    ).resolves.toEqual({
      allowed: false,
      termsRequired: true,
      terms: ACME_TERMS,
    });
  });

  it("does not route or prompt for terms when access is disabled", async () => {
    await expect(
      getExchangeAccessForRequest({
        url: "https://profiles.example/person/example-person",
        formats: [{ type: "markdown" }],
        flags: {
          professionalProfileCompanyDataBeta: true,
          organizationDataSourceAccess: {
            acme: {
              status: "disabled",
              termsKey: "acme",
              termsVersion: "2026-01-01",
              disabledAt: "2026-01-02T00:00:00.000Z",
              disabledReason: "customer_disabled",
            },
          },
        },
      }),
    ).resolves.toEqual({ allowed: false, termsRequired: false });
  });

  it("allows providers with no declared terms without acceptance", async () => {
    await expect(
      getExchangeAccessForRequest({
        url: "https://facts.example/records/1",
        formats: [{ type: "markdown" }],
        flags: { professionalProfileCompanyDataBeta: true },
      }),
    ).resolves.toMatchObject({ allowed: true, provider: { id: "openfacts" } });

    await expect(
      getExchangeAccessForRequest({
        url: "https://facts.example/records/1",
        formats: [{ type: "markdown" }],
        flags: {
          professionalProfileCompanyDataBeta: true,
          organizationDataSourceAccess: {
            openfacts: { status: "disabled" },
          },
        },
      }),
    ).resolves.toEqual({ allowed: false, termsRequired: false });
  });

  it("does not route unless the beta flag is enabled", async () => {
    await expect(
      canUseExchangeForRequest({
        url: "https://profiles.example/person/example-person",
        formats: [{ type: "markdown" }],
      }),
    ).resolves.toBe(false);

    await expect(
      canUseExchangeForRequest({
        url: "https://profiles.example/person/example-person",
        formats: [{ type: "markdown" }],
        flags: { professionalProfileCompanyDataBeta: false },
      }),
    ).resolves.toBe(false);
  });

  it("does not route unless the Exchange is configured", async () => {
    config.FIRE_EXCHANGE_URL = undefined;

    await expect(
      canUseExchangeForRequest({
        url: "https://profiles.example/person/example-person",
        formats: [{ type: "markdown" }],
        flags: ENABLED_EXCHANGE_FLAGS,
      }),
    ).resolves.toBe(false);
  });

  it("bills the reported credit cost only for successful handled responses", () => {
    expect(isSuccessfulExchangeStatusCode(200)).toBe(true);
    expect(isSuccessfulExchangeStatusCode(204)).toBe(true);
    expect(isSuccessfulExchangeStatusCode(304)).toBe(true);
    expect(isSuccessfulExchangeStatusCode(404)).toBe(false);

    expect(
      getExchangeSuccessCredits({
        exchange: { handled: true, creditsCost: 12 },
        statusCode: 200,
      }),
    ).toBe(12);

    expect(
      getExchangeSuccessCredits({
        exchange: { handled: true, creditsCost: 0 },
        statusCode: 304,
      }),
    ).toBe(0);

    expect(
      getExchangeSuccessCredits({
        exchange: { handled: true, creditsCost: 12 },
        statusCode: 404,
      }),
    ).toBeNull();

    expect(
      getExchangeSuccessCredits({
        statusCode: 200,
      }),
    ).toBeNull();
  });

  it("reports billing outcomes without throwing on service failures", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
    } as Awaited<ReturnType<typeof fetch>>);

    await expect(
      reportExchangeBilling({
        accessEventId: "6f1f5aab-3f78-4d0a-8a3d-2b1d3c4e5f60",
        status: "confirmed",
        billingReference: "bill-1",
      }),
    ).resolves.toBe(true);

    expect(fetch).toHaveBeenCalledWith(
      "https://exchange.example/v1/access-events/6f1f5aab-3f78-4d0a-8a3d-2b1d3c4e5f60/billing",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ status: "confirmed", billingReference: "bill-1" }),
      }),
    );

    await expect(
      reportExchangeBilling({
        accessEventId: "6f1f5aab-3f78-4d0a-8a3d-2b1d3c4e5f60",
        status: "void",
      }),
    ).resolves.toBe(true);

    expect(fetch).toHaveBeenLastCalledWith(
      "https://exchange.example/v1/access-events/6f1f5aab-3f78-4d0a-8a3d-2b1d3c4e5f60/billing",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ status: "void" }),
      }),
    );

    vi.mocked(fetch).mockRejectedValue(new Error("connect timeout"));
    vi.useFakeTimers();
    try {
      const report = reportExchangeBilling({
        accessEventId: "6f1f5aab-3f78-4d0a-8a3d-2b1d3c4e5f60",
        status: "confirmed",
        billingReference: "bill-1",
      });
      await vi.runAllTimersAsync();
      await expect(report).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries transient billing report failures and stops on definitive rejections", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
      } as Awaited<ReturnType<typeof fetch>>)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
      } as Awaited<ReturnType<typeof fetch>>);

    vi.useFakeTimers();
    try {
      const report = reportExchangeBilling({
        accessEventId: "6f1f5aab-3f78-4d0a-8a3d-2b1d3c4e5f60",
        status: "confirmed",
      });
      await vi.runAllTimersAsync();
      await expect(report).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
    expect(fetch).toHaveBeenCalledTimes(2);

    // 429 is transient rate limiting, not a final answer: it retries.
    vi.mocked(fetch).mockClear();
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers({ "retry-after": "1" }),
      } as Awaited<ReturnType<typeof fetch>>)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
      } as Awaited<ReturnType<typeof fetch>>);

    vi.useFakeTimers();
    try {
      const report = reportExchangeBilling({
        accessEventId: "6f1f5aab-3f78-4d0a-8a3d-2b1d3c4e5f60",
        status: "confirmed",
      });
      await vi.runAllTimersAsync();
      await expect(report).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
    expect(fetch).toHaveBeenCalledTimes(2);

    // Any other 4xx is the Exchange's final answer (conflict, unknown
    // event): no retry, report failure to the caller.
    vi.mocked(fetch).mockClear();
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 409,
    } as Awaited<ReturnType<typeof fetch>>);

    await expect(
      reportExchangeBilling({
        accessEventId: "6f1f5aab-3f78-4d0a-8a3d-2b1d3c4e5f60",
        status: "void",
      }),
    ).resolves.toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
