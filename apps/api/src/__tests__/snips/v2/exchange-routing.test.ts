/**
 * Unit tests for Exchange routing: the scrape blocklist gate, engine
 * selection in buildFallbackList, and how the exchange engine reports the
 * Exchange's refusals. Unaccepted terms only surface as an error when they
 * are all that keeps the Exchange from serving a blocklisted URL; any other
 * URL scrapes normally, the same way on every route.
 */

const mocks = vi.hoisted(() => ({
  isUrlBlocked: vi.fn(
    (url: string) => new URL(url).hostname === "profiles.example",
  ),
  robustFetch: vi.fn(),
  exchangeRequest: vi.fn(),
}));

vi.mock("../../../scraper/WebScraper/utils/blocklist", () => ({
  isUrlBlocked: mocks.isUrlBlocked,
}));
vi.mock("../../../scraper/scrapeURL/lib/fetch", () => ({
  robustFetch: mocks.robustFetch,
}));
vi.mock("../../../services/alexandria/client", () => ({
  exchangeRequest: mocks.exchangeRequest,
}));

describe("Exchange routing", () => {
  let buildFallbackList: typeof import("../../../scraper/scrapeURL/engines/index.js").buildFallbackList;
  let scrapeURLWithExchange: typeof import("../../../scraper/scrapeURL/engines/exchange.js").scrapeURLWithExchange;
  let scrapeBlocklistMiddleware: typeof import("../../../routes/shared.js").scrapeBlocklistMiddleware;
  let exchange: typeof import("../../../lib/exchange.js");
  let scrapeErrors: typeof import("../../../scraper/scrapeURL/error.js");
  let config: typeof import("../../../config.js").config;
  let originalUseDbAuthentication: boolean | undefined;

  const originalFireEngineUrl = process.env.FIRE_ENGINE_BETA_URL;
  const originalExchangeUrl = process.env.FIRE_EXCHANGE_URL;

  const TERMS = { key: "acme", version: "2026-01-01" };
  const BLOCKED_URL = "https://profiles.example/person/example-person";
  const OPEN_URL = "https://open.example/person/example-person";

  const ACCEPTED_FLAGS = {
    professionalProfileCompanyDataBeta: true,
    organizationDataSourceAccess: {
      acme: {
        status: "enabled",
        termsKey: TERMS.key,
        termsVersion: TERMS.version,
      },
    },
  };
  const UNACCEPTED_FLAGS = { professionalProfileCompanyDataBeta: true };

  beforeAll(async () => {
    process.env.FIRE_ENGINE_BETA_URL = "http://test-fire-engine";
    process.env.FIRE_EXCHANGE_URL = "http://test-exchange";

    // Re-import so modules read the env vars set above at eval time.
    vi.resetModules();
    ({ buildFallbackList } = await import(
      "../../../scraper/scrapeURL/engines/index.js"
    ));
    ({ scrapeURLWithExchange } = await import(
      "../../../scraper/scrapeURL/engines/exchange.js"
    ));
    ({ scrapeBlocklistMiddleware } = await import("../../../routes/shared.js"));
    exchange = await import("../../../lib/exchange.js");
    scrapeErrors = await import("../../../scraper/scrapeURL/error.js");
    ({ config } = await import("../../../config.js"));
  });

  beforeEach(() => {
    originalUseDbAuthentication = config.USE_DB_AUTHENTICATION;
    config.USE_DB_AUTHENTICATION = true;
    // The ledger is unreachable: only the flags can show acceptance.
    mocks.exchangeRequest.mockRejectedValue(new Error("offline"));
    mocks.robustFetch.mockReset();
    exchange.setExchangeProvidersForTest([
      {
        id: "acme",
        creditsCost: 12,
        terms: TERMS,
        routes: [{ domains: ["profiles.example", "open.example"] }],
      },
    ]);
  });

  afterEach(() => {
    config.USE_DB_AUTHENTICATION = originalUseDbAuthentication;
    exchange.clearExchangeProvidersForTest();
  });

  afterAll(() => {
    if (originalFireEngineUrl === undefined) {
      delete process.env.FIRE_ENGINE_BETA_URL;
    } else {
      process.env.FIRE_ENGINE_BETA_URL = originalFireEngineUrl;
    }
    if (originalExchangeUrl === undefined) {
      delete process.env.FIRE_EXCHANGE_URL;
    } else {
      process.env.FIRE_EXCHANGE_URL = originalExchangeUrl;
    }
  });

  const buildStubMeta = (url: string, teamFlags: Record<string, unknown>) =>
    ({
      id: "test",
      url,
      options: {
        formats: [{ type: "markdown" }],
        maxAge: 3600000,
      },
      internalOptions: { teamId: "team-1", orgId: "org-1", teamFlags },
      featureFlags: new Set(),
      mock: null,
      abort: { asSignal: () => undefined },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        child: vi.fn().mockReturnThis(),
      },
    }) as any;

  // Runs the scrape blocklist gate and resolves with the response it sent,
  // or `next` when it let the request through.
  function runGate(
    body: Record<string, unknown>,
    flags: Record<string, unknown>,
  ): Promise<{ next: true } | { status: number; body: any }> {
    return new Promise((resolve, reject) => {
      let statusCode = 200;
      const res: any = {
        headersSent: false,
        status(code: number) {
          statusCode = code;
          return res;
        },
        json(payload: unknown) {
          resolve({ status: statusCode, body: payload });
          return res;
        },
      };
      scrapeBlocklistMiddleware(
        { body, acuc: { flags, team_id: "team-1", org_id: "org-1" } } as any,
        res,
        (error?: unknown) => (error ? reject(error) : resolve({ next: true })),
      );
    });
  }

  describe("scrape blocklist gate", () => {
    it("lets an unblocked URL through even when its provider's terms are unaccepted", async () => {
      await expect(
        runGate({ url: OPEN_URL, formats: ["markdown"] }, UNACCEPTED_FLAGS),
      ).resolves.toEqual({ next: true });
    });

    it("asks for the terms when they are all that keeps a blocked URL out", async () => {
      const result = await runGate(
        { url: BLOCKED_URL, formats: ["markdown"] },
        UNACCEPTED_FLAGS,
      );

      expect(result).toEqual({
        status: 403,
        body: new exchange.ThirdPartyDataTermsRequiredError(TERMS).response(),
      });
    });

    it("lets a blocked URL through when the Exchange can serve it", async () => {
      await expect(
        runGate({ url: BLOCKED_URL, formats: ["markdown"] }, ACCEPTED_FLAGS),
      ).resolves.toEqual({ next: true });
    });

    it("blocks a blocked URL the Exchange cannot serve", async () => {
      exchange.setExchangeProvidersForTest([]);
      const result = await runGate(
        { url: BLOCKED_URL, formats: ["markdown"] },
        ACCEPTED_FLAGS,
      );

      expect(result).toMatchObject({
        status: 403,
        body: { success: false },
      });
      expect((result as any).body.code).toBeUndefined();
    });

    it.each([
      {
        options: { formats: ["markdown", "screenshot"] },
        option: "the `screenshot` format",
      },
      {
        options: { actions: [{ type: "wait", milliseconds: 1000 }] },
        option: "`actions`",
      },
      { options: { zeroDataRetention: true }, option: "zero data retention" },
      { options: { redactPII: true }, option: "`redactPII`" },
    ])(
      "names $option when it keeps the provider out of a blocked URL",
      async ({ options, option }) => {
        const result = await runGate(
          { url: BLOCKED_URL, formats: ["markdown"], ...options },
          ACCEPTED_FLAGS,
        );

        expect(result).toEqual({
          status: 400,
          body: new exchange.ThirdPartyDataUnsupportedOptionError(
            option,
          ).response(),
        });
        expect((result as any).body.code).toBe(
          "THIRD_PARTY_DATA_UNSUPPORTED_OPTION",
        );
        expect((result as any).body.error).toContain(option);
        expect((result as any).body.error).not.toContain("contact-sales");
      },
    );

    it("lets a blocked URL through with formats the provider serves and redactPII off", async () => {
      await expect(
        runGate(
          {
            url: BLOCKED_URL,
            formats: ["markdown", { type: "json", prompt: "Extract the name" }],
            redactPII: false,
          },
          ACCEPTED_FLAGS,
        ),
      ).resolves.toEqual({ next: true });
    });
  });

  describe("buildFallbackList", () => {
    it("routes to the Exchange when the terms are accepted", async () => {
      const fallback = await buildFallbackList(
        buildStubMeta(BLOCKED_URL, ACCEPTED_FLAGS),
      );

      expect(fallback.map(f => f.engine)).toEqual(["exchange"]);
    });

    it("scrapes an unblocked URL normally when the terms are unaccepted", async () => {
      const fallback = await buildFallbackList(
        buildStubMeta(OPEN_URL, UNACCEPTED_FLAGS),
      );
      const engines = fallback.map(f => f.engine);

      expect(engines).not.toContain("exchange");
      expect(engines.length).toBeGreaterThan(0);
    });

    it("raises the terms error for a blocked URL when the terms are unaccepted", async () => {
      const error = await buildFallbackList(
        buildStubMeta(BLOCKED_URL, UNACCEPTED_FLAGS),
      ).catch(e => e);

      expect(error).toBeInstanceOf(exchange.ThirdPartyDataTermsRequiredError);
      expect(error.response()).toEqual(
        new exchange.ThirdPartyDataTermsRequiredError(TERMS).response(),
      );
    });

    it("fails closed for a blocked URL the Exchange cannot serve", async () => {
      exchange.setExchangeProvidersForTest([]);

      await expect(
        buildFallbackList(buildStubMeta(BLOCKED_URL, ACCEPTED_FLAGS)),
      ).resolves.toEqual([]);
    });

    it("names the option that keeps the provider out of a blocked URL", async () => {
      const meta = buildStubMeta(BLOCKED_URL, ACCEPTED_FLAGS);
      meta.options.actions = [{ type: "wait", milliseconds: 1000 }];

      const error = await buildFallbackList(meta).catch(e => e);

      expect(error).toBeInstanceOf(
        exchange.ThirdPartyDataUnsupportedOptionError,
      );
      expect(error.response()).toEqual(
        new exchange.ThirdPartyDataUnsupportedOptionError(
          "`actions`",
        ).response(),
      );
    });
  });

  describe("exchange engine", () => {
    const failure = (code: string, message: string) => ({
      success: false,
      error: { code, message, retryable: false },
    });

    it("reports a missing record as THIRD_PARTY_DATA_NOT_FOUND", async () => {
      mocks.robustFetch.mockResolvedValue(
        failure(
          "record_not_found",
          "The requested Exchange record was not found.",
        ),
      );

      const error = await scrapeURLWithExchange(
        buildStubMeta(BLOCKED_URL, ACCEPTED_FLAGS),
      ).catch(e => e);

      expect(error).toBeInstanceOf(scrapeErrors.ExchangeRefusedError);
      expect(error.code).toBe("THIRD_PARTY_DATA_NOT_FOUND");
      expect(error.message).toBe(
        "The requested Exchange record was not found.",
      );
    });

    it("serves the Exchange's markdown for a supported URL", async () => {
      mocks.robustFetch.mockResolvedValue({
        success: true,
        accessEventId: "access-1",
        creditsCost: 12,
        data: {
          url: BLOCKED_URL,
          title: "Example Person",
          markdown: "# Example Person",
          source: { provider: "acme" },
        },
      });

      const result = await scrapeURLWithExchange(
        buildStubMeta(BLOCKED_URL, ACCEPTED_FLAGS),
      );

      expect(result).toMatchObject({
        url: BLOCKED_URL,
        markdown: "# Example Person",
        statusCode: 200,
        exchange: {
          accessEventId: "access-1",
          provider: { id: "acme", creditsCost: 12 },
        },
      });
    });

    it("reports a provider's missing record as THIRD_PARTY_DATA_NOT_FOUND", async () => {
      mocks.robustFetch.mockResolvedValue(
        failure("not_found", "No matching profile was found."),
      );

      const error = await scrapeURLWithExchange(
        buildStubMeta(BLOCKED_URL, ACCEPTED_FLAGS),
      ).catch(e => e);

      expect(error).toBeInstanceOf(scrapeErrors.ExchangeRefusedError);
      expect(error.code).toBe("THIRD_PARTY_DATA_NOT_FOUND");
      expect(error.message).toBe("No matching profile was found.");
    });

    it("reports a URL the provider does not serve as THIRD_PARTY_DATA_UNSUPPORTED_URL", async () => {
      mocks.robustFetch.mockResolvedValue(
        failure(
          "invalid_exchange_url",
          "Expected a canonical Exchange URL or supported source URL.",
        ),
      );

      const error = await scrapeURLWithExchange(
        buildStubMeta(`${BLOCKED_URL}/details/experience/`, ACCEPTED_FLAGS),
      ).catch(e => e);

      expect(error).toBeInstanceOf(scrapeErrors.ExchangeRefusedError);
      expect(error.code).toBe("THIRD_PARTY_DATA_UNSUPPORTED_URL");
      expect(error.message).not.toContain("canonical Exchange URL");
      expect(error.message).toContain("record's own page");
    });

    it("reports a provider the team lacks as THIRD_PARTY_DATA_NOT_ENABLED", async () => {
      mocks.robustFetch.mockResolvedValue(
        failure(
          "provider_not_enabled",
          "Exchange provider acme is not enabled for this team.",
        ),
      );

      const error = await scrapeURLWithExchange(
        buildStubMeta(BLOCKED_URL, ACCEPTED_FLAGS),
      ).catch(e => e);

      expect(error).toBeInstanceOf(scrapeErrors.ExchangeRefusedError);
      expect(error.code).toBe("THIRD_PARTY_DATA_NOT_ENABLED");
      expect(error.message).toBe(
        "Exchange provider acme is not enabled for this team.",
      );
    });

    it("keeps any other failure an engine error", async () => {
      mocks.robustFetch.mockResolvedValue(
        failure(
          "internal_error",
          "The Exchange request could not be completed.",
        ),
      );

      const error = await scrapeURLWithExchange(
        buildStubMeta(BLOCKED_URL, ACCEPTED_FLAGS),
      ).catch(e => e);

      expect(error).toBeInstanceOf(scrapeErrors.EngineError);
    });
  });
});
