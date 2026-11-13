/**
 * Unit test for stealth proxy engine routing via buildFallbackList.
 * Without fire-engine no engine fetches a page through a stealth proxy, so an
 * auto-proxy scrape that escalates to stealthProxy must keep the regular page
 * engines instead of narrowing to the file parsers.
 */

describe("Stealth proxy routing without fire-engine (buildFallbackList)", () => {
  let buildFallbackList: typeof import("../../../scraper/scrapeURL/engines/index.js").buildFallbackList;

  const overrides: Record<string, string | undefined> = {
    FIRE_ENGINE_BETA_URL: undefined,
    FIRE_EXCHANGE_URL: undefined,
    INDEX_DATABASE_URL: undefined,
    PLAYWRIGHT_MICROSERVICE_URL: "http://test-playwright",
  };
  const original: Record<string, string | undefined> = {};

  const setEnv = (env: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };

  beforeAll(async () => {
    for (const key of Object.keys(overrides)) {
      original[key] = process.env[key];
    }
    setEnv(overrides);

    // Re-import engines fresh so it reads the env vars set above at eval time.
    vi.resetModules();
    ({ buildFallbackList } = await import(
      "../../../scraper/scrapeURL/engines/index.js"
    ));
  });

  afterAll(() => {
    setEnv(original);
  });

  const buildStubMeta = (featureFlags: string[]) =>
    ({
      id: "test",
      url: "https://example.com/",
      options: {
        formats: [],
        maxAge: 0,
        proxy: "auto",
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

  it("keeps the page engines when stealthProxy is added to an HTML scrape", async () => {
    const before = await buildFallbackList(buildStubMeta([]));
    const after = await buildFallbackList(buildStubMeta(["stealthProxy"]));

    expect(before.map(f => f.engine)).toEqual(["playwright", "fetch"]);
    expect(after.map(f => f.engine)).toEqual(["playwright", "fetch"]);
  });

  it("still routes PDFs to the pdf engine when stealthProxy is set", async () => {
    const fallback = await buildFallbackList(
      buildStubMeta(["pdf", "stealthProxy"]),
    );

    expect(fallback.map(f => f.engine)).toEqual(["pdf"]);
  });
});
