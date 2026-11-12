/**
 * Unit test for stealth proxy engine routing via buildFallbackList with
 * fire-engine configured. These are the fallback lists fire-engine
 * deployments use, pinned so the self-hosted stealthProxy handling cannot
 * change them.
 */

describe("Stealth proxy routing with fire-engine (buildFallbackList)", () => {
  let buildFallbackList: typeof import("../../../scraper/scrapeURL/engines/index.js").buildFallbackList;

  const overrides: Record<string, string | undefined> = {
    FIRE_ENGINE_BETA_URL: "http://test-fire-engine",
    FIRE_EXCHANGE_URL: undefined,
    INDEX_DATABASE_URL: undefined,
    PLAYWRIGHT_MICROSERVICE_URL: undefined,
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

  const engines = async (
    url: string,
    featureFlags: string[],
    proxy: "auto" | "stealth",
  ) =>
    (
      await buildFallbackList({
        id: "test",
        url,
        options: { formats: [], maxAge: 0, proxy },
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
      } as any)
    ).map(f => f.engine);

  const cdp = ["fire-engine;chrome-cdp", "fire-engine(retry);chrome-cdp"];
  const cdpStealth = [
    "fire-engine;chrome-cdp;stealth",
    "fire-engine(retry);chrome-cdp;stealth",
  ];

  it("routes a regular HTML scrape to chrome-cdp", async () => {
    expect(await engines("https://example.com/", [], "auto")).toEqual(cdp);
  });

  it("narrows an HTML scrape that escalated to stealthProxy to the stealth engines", async () => {
    expect(
      await engines("https://example.com/", ["stealthProxy"], "auto"),
    ).toEqual([...cdpStealth, "pdf", "document"]);
  });

  it("narrows an explicit stealth HTML scrape to the stealth engines", async () => {
    expect(
      await engines("https://example.com/", ["stealthProxy"], "stealth"),
    ).toEqual([...cdpStealth, "pdf", "document"]);
  });

  it("routes a PDF through the browser engines", async () => {
    expect(await engines("https://example.com/a.pdf", ["pdf"], "auto")).toEqual(
      [...cdp, ...cdpStealth],
    );
  });

  it("routes a PDF that escalated to stealthProxy through the stealth engines", async () => {
    expect(
      await engines(
        "https://example.com/a.pdf",
        ["pdf", "stealthProxy"],
        "auto",
      ),
    ).toEqual(cdpStealth);
  });

  it("routes an explicit stealth document through the stealth engines", async () => {
    expect(
      await engines(
        "https://example.com/a.docx",
        ["document", "stealthProxy"],
        "stealth",
      ),
    ).toEqual(cdpStealth);
  });
});
