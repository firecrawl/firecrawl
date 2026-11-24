/**
 * Unit tests for the scrape blocklist gate with Exchange access checks.
 * Unaccepted terms only surface as an error when they are all that keeps the
 * Exchange from serving a blocklisted URL; any other URL scrapes normally.
 */

const mocks = vi.hoisted(() => ({
  isUrlBlocked: vi.fn(
    (url: string) => new URL(url).hostname === "profiles.example",
  ),
  exchangeRequest: vi.fn(),
}));

vi.mock("../../../services/alexandria/client", () => ({
  exchangeRequest: mocks.exchangeRequest,
}));

describe("Exchange routing", () => {
  let scrapeBlocklistMiddleware: typeof import("../../../routes/shared.js").scrapeBlocklistMiddleware;
  let replaceService: typeof import("../../../service/service.js").replaceService;
  let exchange: typeof import("../../../lib/exchange.js");
  let config: typeof import("../../../config.js").config;
  let originalUseDbAuthentication: boolean | undefined;

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
    process.env.FIRE_EXCHANGE_URL = "http://test-exchange";

    // Re-import so modules read the env vars set above at eval time.
    vi.resetModules();
    const enginesModule = await import(
      "../../../scraper/scrapeURL/engines/index.js"
    );
    const serviceModule = await import("../../../service/service.js");
    const defaultsModule = await import("../../../service/defaults.js");
    replaceService = serviceModule.replaceService;
    replaceService(
      serviceModule.createService(
        {
          modules: {
            blocklist: {
              ...defaultsModule.noBlocklist(),
              isBlocked: mocks.isUrlBlocked,
            },
          },
        },
        {
          core: {
            name: "core",
            engines: enginesModule.coreEngines,
            engineFeatures: enginesModule.coreEngineFeatures,
          },
          logger: { error: vi.fn() },
        },
      ),
    );
    ({ scrapeBlocklistMiddleware } = await import("../../../routes/shared.js"));
    exchange = await import("../../../lib/exchange.js");
    ({ config } = await import("../../../config.js"));
  });

  beforeEach(() => {
    originalUseDbAuthentication = config.USE_DB_AUTHENTICATION;
    config.USE_DB_AUTHENTICATION = true;
    // The ledger is unreachable: only the flags can show acceptance.
    mocks.exchangeRequest.mockRejectedValue(new Error("offline"));
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
    replaceService(undefined);
    if (originalExchangeUrl === undefined) {
      delete process.env.FIRE_EXCHANGE_URL;
    } else {
      process.env.FIRE_EXCHANGE_URL = originalExchangeUrl;
    }
  });

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
});
