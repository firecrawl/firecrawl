/**
 * Unit tests for mobile feature engine routing via buildFallbackList.
 *
 * Self-hosted deployments rely on the playwright engine (no fire-engine).
 * If playwright does not advertise mobile support, mobile scrapes either
 * fail with SCRAPE_ALL_ENGINES_FAILED or fall through to engines that ignore
 * the flag. See #3744.
 */

describe("Mobile feature engine routing (buildFallbackList)", () => {
  let buildFallbackList: typeof import("../../../scraper/scrapeURL/engines/index.js").buildFallbackList;
  let clearExchangeProvidersForTest: typeof import("../../../lib/exchange.js").clearExchangeProvidersForTest;

  const originalFireEngineUrl = process.env.FIRE_ENGINE_BETA_URL;
  const originalIndexUrl = process.env.INDEX_DATABASE_URL;
  const originalPlaywrightUrl = process.env.PLAYWRIGHT_MICROSERVICE_URL;
  const originalExchangeUrl = process.env.FIRE_EXCHANGE_URL;

  beforeAll(async () => {
    // Self-hosted shape: playwright available, fire-engine / exchange / index not.
    delete process.env.FIRE_ENGINE_BETA_URL;
    delete process.env.FIRE_EXCHANGE_URL;
    delete process.env.INDEX_DATABASE_URL;
    process.env.PLAYWRIGHT_MICROSERVICE_URL = "http://playwright-service:3000/scrape";

    vi.resetModules();
    ({ buildFallbackList } = await import(
      "../../../scraper/scrapeURL/engines/index.js"
    ));
    ({ clearExchangeProvidersForTest } = await import(
      "../../../lib/exchange.js"
    ));
  });

  afterEach(() => {
    clearExchangeProvidersForTest();
  });

  afterAll(() => {
    if (originalFireEngineUrl === undefined) {
      delete process.env.FIRE_ENGINE_BETA_URL;
    } else {
      process.env.FIRE_ENGINE_BETA_URL = originalFireEngineUrl;
    }
    if (originalIndexUrl === undefined) {
      delete process.env.INDEX_DATABASE_URL;
    } else {
      process.env.INDEX_DATABASE_URL = originalIndexUrl;
    }
    if (originalPlaywrightUrl === undefined) {
      delete process.env.PLAYWRIGHT_MICROSERVICE_URL;
    } else {
      process.env.PLAYWRIGHT_MICROSERVICE_URL = originalPlaywrightUrl;
    }
    if (originalExchangeUrl === undefined) {
      delete process.env.FIRE_EXCHANGE_URL;
    } else {
      process.env.FIRE_EXCHANGE_URL = originalExchangeUrl;
    }
  });

  const buildStubMeta = (featureFlags: string[], opts: { mobile?: boolean } = {}) =>
    ({
      id: "test",
      url: "https://example.com",
      options: {
        formats: [{ type: "markdown" }],
        maxAge: 0,
        mobile: opts.mobile ?? featureFlags.includes("mobile"),
      },
      internalOptions: { teamId: "test" },
      featureFlags: new Set(featureFlags),
      mock: null,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        child: vi.fn().mockReturnThis(),
      },
    }) as any;

  it("selects playwright for mobile scrapes on self-hosted (no fire-engine)", async () => {
    const fallback = await buildFallbackList(
      buildStubMeta(["mobile"], { mobile: true }),
    );
    const engines = fallback.map(f => f.engine);

    expect(engines.length).toBeGreaterThan(0);
    expect(engines).toContain("playwright");

    const playwright = fallback.find(f => f.engine === "playwright");
    expect(playwright).toBeDefined();
    expect(playwright!.unsupportedFeatures.has("mobile")).toBe(false);
  });

  it("does not leave the mobile fallback list empty (regression for #3744)", async () => {
    const fallback = await buildFallbackList(
      buildStubMeta(["mobile"], { mobile: true }),
    );

    // Empty list used to surface as SCRAPE_ALL_ENGINES_FAILED with
    // "Engines tried: []" on self-hosted mobile scrapes.
    expect(fallback.length).toBeGreaterThan(0);
  });

  it("still allows playwright for non-mobile scrapes", async () => {
    const fallback = await buildFallbackList(buildStubMeta([]));
    const engines = fallback.map(f => f.engine);

    expect(engines).toContain("playwright");
    expect(engines).toContain("fetch");
  });
});
