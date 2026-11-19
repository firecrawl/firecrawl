/**
 * Unit test for Wikipedia engine routing via buildFallbackList: zero data
 * retention scrapes of Wikimedia URLs never use the Wikipedia engine.
 */

describe("Wikipedia engine routing under zero data retention (buildFallbackList)", () => {
  let buildFallbackList: typeof import("../../../scraper/scrapeURL/engines/index.js").buildFallbackList;

  const env = {
    FIRE_ENGINE_BETA_URL: process.env.FIRE_ENGINE_BETA_URL,
    WIKIPEDIA_ENTERPRISE_USERNAME: process.env.WIKIPEDIA_ENTERPRISE_USERNAME,
    WIKIPEDIA_ENTERPRISE_PASSWORD: process.env.WIKIPEDIA_ENTERPRISE_PASSWORD,
  };

  beforeAll(async () => {
    process.env.FIRE_ENGINE_BETA_URL = "http://test-fire-engine";
    process.env.WIKIPEDIA_ENTERPRISE_USERNAME = "test-user";
    process.env.WIKIPEDIA_ENTERPRISE_PASSWORD = "test-password";

    // Re-import engines fresh so it reads the env vars set above at eval time.
    vi.resetModules();
    ({ buildFallbackList } = await import(
      "../../../scraper/scrapeURL/engines/index.js"
    ));
  });

  beforeEach(() => {
    // Below 0.5, so a Wikimedia URL keeps the Wikipedia engine when allowed.
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  const buildStubMeta = (
    url: string,
    zeroDataRetention: boolean,
    forceEngine?: string[],
  ) =>
    ({
      id: "test",
      url,
      options: {
        formats: [],
        maxAge: 0,
      },
      internalOptions: { teamId: "test", zeroDataRetention, forceEngine },
      featureFlags: new Set(),
      mock: null,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        child: vi.fn().mockReturnThis(),
      },
    }) as any;

  const enginesFor = async (url: string, zeroDataRetention: boolean) =>
    (await buildFallbackList(buildStubMeta(url, zeroDataRetention))).map(
      f => f.engine,
    );

  it("uses the Wikipedia engine for a Wikimedia URL without zero data retention", async () => {
    const engines = await enginesFor(
      "https://en.wikipedia.org/wiki/Web_scraping",
      false,
    );

    expect(engines).toContain("wikipedia");
  });

  it("skips the Wikipedia engine for a zero data retention scrape of a Wikimedia URL", async () => {
    const engines = await enginesFor(
      "https://en.wikipedia.org/wiki/Web_scraping",
      true,
    );

    expect(engines).not.toContain("wikipedia");
    expect(engines).toContain("fire-engine;chrome-cdp");
  });

  it("skips a forced Wikipedia engine under zero data retention", async () => {
    const meta = (zeroDataRetention: boolean) =>
      buildStubMeta(
        "https://en.wikipedia.org/wiki/Web_scraping",
        zeroDataRetention,
        ["wikipedia", "fire-engine;chrome-cdp"],
      );

    const forced = (await buildFallbackList(meta(false))).map(f => f.engine);
    expect(forced).toContain("wikipedia");

    const zdr = (await buildFallbackList(meta(true))).map(f => f.engine);
    expect(zdr).not.toContain("wikipedia");
    expect(zdr).toContain("fire-engine;chrome-cdp");
  });

  it("leaves non-Wikimedia URLs off the Wikipedia engine either way", async () => {
    expect(await enginesFor("https://example.com/", false)).not.toContain(
      "wikipedia",
    );
    expect(await enginesFor("https://example.com/", true)).not.toContain(
      "wikipedia",
    );
  });
});
