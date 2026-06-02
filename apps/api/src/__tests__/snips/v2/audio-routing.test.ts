/**
 * Unit test for audio-format engine routing via buildFallbackList.
 * Verifies that requesting audio format routes through chrome-cdp before
 * audio postprocessing so browser cookies are available for avgrab.
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
  const originalIndexUrl = process.env.INDEX_DATABASE_URL;

  beforeAll(() => {
    process.env.FIRE_ENGINE_BETA_URL = "http://test-fire-engine";
    process.env.INDEX_DATABASE_URL =
      "postgresql://postgres:postgres@localhost:5432/postgres";

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
        info: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        error: jest.fn(),
        child: jest.fn().mockReturnThis(),
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
