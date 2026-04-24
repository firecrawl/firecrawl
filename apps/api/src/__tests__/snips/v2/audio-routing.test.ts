/**
 * Unit test for audio-format engine routing via buildFallbackList.
 * Verifies that requesting audio format selects only index + tlsclient
 * engines (chrome-cdp and others are excluded) and that non-audio
 * requests still route through chrome-cdp as primary.
 */

// Avoid jest ESM-parse issues on transitive `uuid` import when pulling in engines.
jest.mock("uuid", () => ({
  v4: () => "test-uuid-v4",
  v7: () => "test-uuid-v7",
  validate: () => true,
}));

describe("Audio format engine routing (buildFallbackList)", () => {
  let buildFallbackList: typeof import("../../../scraper/scrapeURL/engines").buildFallbackList;

  const originalFireEngineUrl = process.env.FIRE_ENGINE_BETA_URL;
  const originalIndexUrl = process.env.INDEX_SUPABASE_URL;

  beforeAll(() => {
    process.env.FIRE_ENGINE_BETA_URL = "http://test-fire-engine";
    process.env.INDEX_SUPABASE_URL = "http://test-index-supabase";

    jest.isolateModules(() => {
      buildFallbackList =
        require("../../../scraper/scrapeURL/engines").buildFallbackList;
    });
  });

  afterAll(() => {
    if (originalFireEngineUrl === undefined) {
      delete process.env.FIRE_ENGINE_BETA_URL;
    } else {
      process.env.FIRE_ENGINE_BETA_URL = originalFireEngineUrl;
    }
    if (originalIndexUrl === undefined) {
      delete process.env.INDEX_SUPABASE_URL;
    } else {
      process.env.INDEX_SUPABASE_URL = originalIndexUrl;
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
        info: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        error: jest.fn(),
        child: jest.fn().mockReturnThis(),
      },
    }) as any;

  it("routes audio format to index then tlsclient only", async () => {
    const fallback = await buildFallbackList(buildStubMeta(["audio"]));
    const engines = fallback.map(f => f.engine);

    // Cache-first (index, quality 1000), then tlsclient (quality 10).
    // index;documents and tlsclient;stealth drop out via the positive-quality filter.
    expect(engines).toEqual(["index", "fire-engine;tlsclient"]);
  });

  it("excludes chrome-cdp engines when audio format is requested", async () => {
    const fallback = await buildFallbackList(buildStubMeta(["audio"]));
    const engines = fallback.map(f => f.engine);

    expect(engines).not.toContain("fire-engine;chrome-cdp");
    expect(engines).not.toContain("fire-engine;chrome-cdp;stealth");
    expect(engines).not.toContain("fire-engine(retry);chrome-cdp");
    expect(engines).not.toContain("fire-engine(retry);chrome-cdp;stealth");
    expect(engines).not.toContain("fetch");
  });

  it("still allows chrome-cdp for non-audio requests", async () => {
    const fallback = await buildFallbackList(buildStubMeta([]));
    const engines = fallback.map(f => f.engine);

    expect(engines).toContain("fire-engine;chrome-cdp");
  });
});
