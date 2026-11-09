/**
 * Unit test for audio-format engine routing via buildFallbackList.
 * Verifies that requesting audio format routes through chrome-cdp before
 * audio postprocessing so browser cookies are available for avgrab.
 */

describe("Audio format engine routing (buildFallbackList)", () => {
  let buildFallbackList: typeof import("../../../scraper/scrapeURL/engines/index.js").buildFallbackList;
  let clearExchangeProvidersForTest: typeof import("../../../lib/exchange.js").clearExchangeProvidersForTest;
  let setExchangeProvidersForTest: typeof import("../../../lib/exchange.js").setExchangeProvidersForTest;

  const originalFireEngineUrl = process.env.FIRE_ENGINE_BETA_URL;
  const originalIndexUrl = process.env.INDEX_DATABASE_URL;
  const originalExchangeUrl = process.env.FIRE_EXCHANGE_URL;

  beforeAll(async () => {
    process.env.FIRE_ENGINE_BETA_URL = "http://test-fire-engine";
    process.env.FIRE_EXCHANGE_URL = "http://test-exchange";
    process.env.INDEX_DATABASE_URL =
      "postgresql://postgres:postgres@localhost:5432/postgres";

    // Re-import engines fresh so it reads the env vars set above at eval time.
    vi.resetModules();
    ({ buildFallbackList } = await import(
      "../../../scraper/scrapeURL/engines/index.js"
    ));
    ({
      clearExchangeProvidersForTest,
      setExchangeProvidersForTest,
    } = await import("../../../lib/exchange.js"));
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
    if (originalExchangeUrl === undefined) {
      delete process.env.FIRE_EXCHANGE_URL;
    } else {
      process.env.FIRE_EXCHANGE_URL = originalExchangeUrl;
    }
  });

  const buildStubMeta = (featureFlags: string[]) =>
    ({
      id: "test",
      url: "https://www.youtube.com/watch?v=abc",
      options: {
        formats: [],
        maxAge: 3600000,
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

  it("routes audio format to chrome-cdp before tlsclient", async () => {
    const fallback = await buildFallbackList(buildStubMeta(["audio"]));
    const engines = fallback.map(f => f.engine);

    expect(engines).toEqual([
      "fire-engine;chrome-cdp",
      "fire-engine(retry);chrome-cdp",
      "fire-engine;tlsclient",
    ]);
  });

  it("excludes index and non-browser engines when audio format is requested", async () => {
    const fallback = await buildFallbackList(buildStubMeta(["audio"]));
    const engines = fallback.map(f => f.engine);

    expect(engines).toContain("fire-engine;chrome-cdp");
    expect(engines).toContain("fire-engine(retry);chrome-cdp");
    expect(engines).not.toContain("index");
    expect(engines).not.toContain("index;documents");
    expect(engines).not.toContain("fire-engine;chrome-cdp;stealth");
    expect(engines).not.toContain("fire-engine(retry);chrome-cdp;stealth");
    expect(engines).not.toContain("fetch");
  });

  it("routes video format to chrome-cdp before tlsclient", async () => {
    const fallback = await buildFallbackList(buildStubMeta(["video"]));
    const engines = fallback.map(f => f.engine);

    expect(engines).toEqual([
      "fire-engine;chrome-cdp",
      "fire-engine(retry);chrome-cdp",
      "fire-engine;tlsclient",
    ]);
  });

  it("excludes index and non-browser engines when video format is requested", async () => {
    const fallback = await buildFallbackList(buildStubMeta(["video"]));
    const engines = fallback.map(f => f.engine);

    expect(engines).toContain("fire-engine;chrome-cdp");
    expect(engines).toContain("fire-engine(retry);chrome-cdp");
    expect(engines).not.toContain("index");
    expect(engines).not.toContain("index;documents");
    expect(engines).not.toContain("fire-engine;chrome-cdp;stealth");
    expect(engines).not.toContain("fire-engine(retry);chrome-cdp;stealth");
    expect(engines).not.toContain("fetch");
  });

  it("still allows chrome-cdp for non-audio requests", async () => {
    const fallback = await buildFallbackList(buildStubMeta([]));
    const engines = fallback.map(f => f.engine);

    expect(engines).toContain("fire-engine;chrome-cdp");
  });

  it("does not route agent index-only requests through the Exchange", async () => {
    setExchangeProvidersForTest([
      { id: "acme", routes: [{ domains: ["profiles.example"] }] },
    ]);

    const meta = buildStubMeta([]);
    meta.url = "https://profiles.example/person/example-person";
    meta.options.formats = [{ type: "markdown" }];
    meta.internalOptions.agentIndexOnly = true;
    meta.internalOptions.teamFlags = { professionalProfileCompanyDataBeta: true };

    const fallback = await buildFallbackList(meta);
    const engines = fallback.map(f => f.engine);

    expect(engines).toEqual(["index", "index;documents"]);
  });
});
