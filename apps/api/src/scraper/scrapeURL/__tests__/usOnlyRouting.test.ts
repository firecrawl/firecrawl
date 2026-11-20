/**
 * Unit test for US-only engine routing via buildFallbackList with fire-engine
 * configured. A US-only team's scrape never uses an engine that downloads
 * outside fire-engine, except to parse content that is already in hand.
 */

describe("US-only routing with fire-engine (buildFallbackList)", () => {
  let buildFallbackList: typeof import("../engines/index.js").buildFallbackList;

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
    ({ buildFallbackList } = await import("../engines/index.js"));
  });

  afterAll(() => {
    setEnv(original);
  });

  const fallbackList = (
    usOnly: boolean,
    featureFlags: string[],
    extra: Record<string, unknown> = {},
    internalOptions: Record<string, unknown> = {},
  ) =>
    buildFallbackList({
      id: "test",
      url: "https://example.com/report.pdf",
      options: { formats: [], maxAge: 0, proxy: "auto" },
      internalOptions: {
        teamId: "test",
        ...(usOnly ? { teamFlags: { usOnly: true } } : {}),
        ...internalOptions,
      },
      featureFlags: new Set(featureFlags),
      mock: null,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        child: vi.fn().mockReturnThis(),
      },
      ...extra,
    } as any);

  const engines = async (...args: Parameters<typeof fallbackList>) =>
    (await fallbackList(...args)).map(f => f.engine);

  const pdfPrefetch = {
    filePath: "/tmp/us-only-routing.pdf",
    status: 200,
    url: "https://example.com/report.pdf",
    proxyUsed: "basic",
    contentType: "application/pdf",
  };

  it("keeps a fast-mode scrape on fire-engine instead of the fetch engine", async () => {
    expect(await engines(false, ["useFastMode"])).toContain("fetch");

    const usOnly = await engines(true, ["useFastMode"]);
    expect(usOnly).not.toContain("fetch");
    expect(usOnly).toContain("fire-engine;tlsclient");
  });

  it("drops the fetch engine from a forced list, as robots.txt and sitemaps use", async () => {
    const forceEngine = [
      "fetch",
      "fire-engine;tlsclient",
      "fire-engine;tlsclient;stealth",
    ];

    expect(await engines(false, [], {}, { forceEngine })).toContain("fetch");
    expect(await engines(true, [], {}, { forceEngine })).toEqual([
      "fire-engine;tlsclient",
    ]);
  });

  it("drops the file engines from a stealth retry of an HTML page", async () => {
    const usOnly = await engines(true, ["stealthProxy"]);

    expect(usOnly.length).toBeGreaterThan(0);
    for (const engine of ["fetch", "pdf", "document", "image"]) {
      expect(usOnly).not.toContain(engine);
    }
  });

  it("fails closed when a PDF would have to be downloaded directly", async () => {
    // A null prefetch means the browser ran but delivered no file.
    expect(await engines(false, ["pdf"], { pdfPrefetch: null })).toEqual([
      "pdf",
    ]);

    await expect(
      fallbackList(true, ["pdf"], { pdfPrefetch: null }),
    ).rejects.toMatchObject({ code: "US_ONLY_UNAVAILABLE" });
  });

  it("parses a PDF that fire-engine already delivered", async () => {
    expect(await engines(true, ["pdf"], { pdfPrefetch })).toEqual(["pdf"]);
  });

  it("parses an uploaded HTML file with the fetch engine", async () => {
    expect(
      await engines(
        true,
        [],
        {
          fetchPrefetch: {
            url: "https://example.com/upload.html",
            status: 200,
            bodyBuffer: Buffer.from("<html></html>"),
            proxyUsed: "basic",
            contentType: "text/html",
          },
        },
        { forceEngine: "fetch", isParse: true },
      ),
    ).toEqual(["fetch"]);
  });
});
