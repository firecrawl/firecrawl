import { createLogger } from "winston";
import {
  applyScrapeOptionsDefaults,
  scrapeOptions,
} from "../../../controllers/v2/types";
import { CostTracking } from "../../../lib/cost-tracking";
import { requestContext } from "../../../lib/request-context";
import type { Meta } from "../../../scraper/scrapeURL";
import type {
  buildFallbackList as BuildFallbackList,
  Engine,
} from "../../../scraper/scrapeURL/engines/index.js";
import { AbortManager } from "../../../scraper/scrapeURL/lib/abortManager";
import type { replaceService as ReplaceService } from "../../../service/service.js";

/**
 * Unit test for Wikipedia engine routing via buildFallbackList: zero data
 * retention scrapes of Wikimedia URLs never use the Wikipedia engine.
 */

const buildStubMeta = (
  url: string,
  zeroDataRetention: boolean,
  forceEngine?: Array<Engine>,
): Meta => {
  const options = {
    ...applyScrapeOptionsDefaults(
      scrapeOptions.parse({
        formats: [],
      }),
    ),
    maxAge: 0,
  };
  return {
    id: "test",
    url,
    ctx: requestContext({ teamId: "test", zeroDataRetention }),
    state: {},
    options,
    internalOptions: {
      teamId: "test",
      orgId: null,
      zeroDataRetention,
      forceEngine,
    },
    featureFlags: new Set(),
    mock: null,
    logger: createLogger({ silent: true }),
    abort: new AbortManager(),
    imageOcrEnabled: async () => false,
    pdfPrefetch: undefined,
    documentPrefetch: undefined,
    imagePrefetch: undefined,
    fetchPrefetch: undefined,
    costTracking: new CostTracking(),
    threatDecisions: [],
  };
};

const buildForcedWikipediaMeta = (zeroDataRetention: boolean) =>
  buildStubMeta(
    "https://en.wikipedia.org/wiki/Web_scraping",
    zeroDataRetention,
    ["wikipedia", "fetch"],
  );

describe("Wikipedia engine routing under zero data retention (buildFallbackList)", () => {
  let buildFallbackList: typeof BuildFallbackList;
  let replaceService: typeof ReplaceService | undefined;

  const env = {
    WIKIPEDIA_ENTERPRISE_USERNAME: process.env.WIKIPEDIA_ENTERPRISE_USERNAME,
    WIKIPEDIA_ENTERPRISE_PASSWORD: process.env.WIKIPEDIA_ENTERPRISE_PASSWORD,
  };

  beforeAll(async () => {
    process.env.WIKIPEDIA_ENTERPRISE_USERNAME = "test-user";
    process.env.WIKIPEDIA_ENTERPRISE_PASSWORD = "test-password";

    // Re-import engines fresh so it reads the env vars set above at eval time.
    vi.resetModules();
    const enginesModule =
      await import("../../../scraper/scrapeURL/engines/index.js");
    const serviceModule = await import("../../../service/service.js");
    buildFallbackList = enginesModule.buildFallbackList;
    replaceService = serviceModule.replaceService;
    replaceService(
      serviceModule.createService(
        { modules: {} },
        {
          core: {
            name: "core",
            engines: enginesModule.coreEngines,
            engineFeatures: enginesModule.coreEngineFeatures,
          },
          logger: { error: vi.fn() },
        },
      ),
    );
  });

  beforeEach(() => {
    // Below 0.5, so a Wikimedia URL keeps the Wikipedia engine when allowed.
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    replaceService?.(undefined);
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

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
    expect(engines).toContain("fetch");
  });

  it("skips a forced Wikipedia engine under zero data retention", async () => {
    const forced = (
      await buildFallbackList(buildForcedWikipediaMeta(false))
    ).map(f => f.engine);
    expect(forced).toContain("wikipedia");

    const zdr = (await buildFallbackList(buildForcedWikipediaMeta(true))).map(
      f => f.engine,
    );
    expect(zdr).not.toContain("wikipedia");
    expect(zdr).toContain("fetch");
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
