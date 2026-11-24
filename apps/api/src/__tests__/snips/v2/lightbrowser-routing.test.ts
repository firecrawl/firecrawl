/**
 * Unit test for lightweight browser engine routing via buildFallbackList.
 * Verifies the tier order (Lightpanda -> Moli -> Playwright/Chromium) for
 * requests the lightweight engines can serve, and that capability-gated
 * requests (screenshots, actions) bypass the lightweight tiers entirely.
 */

describe("Lightweight browser engine routing (buildFallbackList)", () => {
  let buildFallbackList: typeof import("../../../scraper/scrapeURL/engines/index.js").buildFallbackList;

  const originalPlaywrightUrl = process.env.PLAYWRIGHT_MICROSERVICE_URL;
  const originalLightpandaEnabled = process.env.LIGHTPANDA_ENABLED;
  const originalMoliEnabled = process.env.MOLI_ENABLED;

  beforeAll(async () => {
    process.env.PLAYWRIGHT_MICROSERVICE_URL = "http://test-playwright:3003";
    process.env.LIGHTPANDA_ENABLED = "true";
    process.env.MOLI_ENABLED = "true";

    // Re-import engines fresh so it reads the env vars set above at eval time.
    vi.resetModules();
    ({ buildFallbackList } = await import(
      "../../../scraper/scrapeURL/engines/index.js"
    ));
  });

  afterAll(() => {
    for (const [key, original] of [
      ["PLAYWRIGHT_MICROSERVICE_URL", originalPlaywrightUrl],
      ["LIGHTPANDA_ENABLED", originalLightpandaEnabled],
      ["MOLI_ENABLED", originalMoliEnabled],
    ] as const) {
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
  });

  const buildStubMeta = (featureFlags: string[]) =>
    ({
      id: "test",
      url: "https://example.com/article",
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

  it("orders plain scrapes Lightpanda -> Moli -> Playwright -> fetch", async () => {
    const fallback = await buildFallbackList(buildStubMeta([]));
    const engines = fallback.map(f => f.engine);

    expect(engines).toEqual(["lightpanda", "moli", "playwright", "fetch"]);
  });

  it("keeps Lightpanda first for waitFor requests", async () => {
    const fallback = await buildFallbackList(buildStubMeta(["waitFor"]));
    const engines = fallback.map(f => f.engine);

    expect(engines[0]).toBe("lightpanda");
    expect(engines).toContain("moli");
  });

  it("bypasses the lightweight tiers for screenshot requests", async () => {
    const fallback = await buildFallbackList(buildStubMeta(["screenshot"]));
    const engines = fallback.map(f => f.engine);

    expect(engines).not.toContain("lightpanda");
    expect(engines).not.toContain("moli");
  });

  it("bypasses the lightweight tiers for action requests", async () => {
    const fallback = await buildFallbackList(buildStubMeta(["actions"]));
    const engines = fallback.map(f => f.engine);

    expect(engines).not.toContain("lightpanda");
    expect(engines).not.toContain("moli");
    expect(engines).not.toContain("playwright");
  });
});
