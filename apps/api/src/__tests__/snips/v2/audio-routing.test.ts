/**
 * Unit test for audio-format engine routing via buildFallbackList.
 * Verifies that requesting audio format routes through chrome-cdp before
 * audio postprocessing so browser cookies are available for avgrab.
 */

describe("Audio format engine routing (buildFallbackList)", () => {
  let buildFallbackList: typeof import("../../../scraper/scrapeURL/engines").buildFallbackList;

  const originalFireEngineUrl = process.env.FIRE_ENGINE_BETA_URL;
  const originalIndexUrl = process.env.INDEX_DATABASE_URL;

  beforeAll(async () => {
    process.env.FIRE_ENGINE_BETA_URL = "http://test-fire-engine";
    process.env.INDEX_DATABASE_URL =
      "postgresql://postgres:postgres@localhost:5432/postgres";

    // Re-import engines fresh so it reads the env vars set above at eval time.
    vi.resetModules();
    ({ buildFallbackList } = await import(
      "../../../scraper/scrapeURL/engines/index.js"
    ));
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
});
