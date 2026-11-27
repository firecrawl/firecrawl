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
  FeatureFlag,
} from "../../../scraper/scrapeURL/engines/index.js";
import { AbortManager } from "../../../scraper/scrapeURL/lib/abortManager";
import type { replaceService as ReplaceService } from "../../../service/service.js";

/**
 * Unit test for stealth proxy engine routing via buildFallbackList.
 * Without fire-engine no engine fetches a page through a stealth proxy, so an
 * auto-proxy scrape that escalates to stealthProxy must keep the regular page
 * engines instead of narrowing to the file parsers.
 */

const setEnv = (env: Record<string, string | undefined>) => {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
};

const buildStubMeta = (featureFlags: Array<FeatureFlag>): Meta => {
  const options = {
    ...applyScrapeOptionsDefaults(
      scrapeOptions.parse({
        formats: [],
        proxy: "auto",
      }),
    ),
    maxAge: 0,
  };
  return {
    id: "test",
    url: "https://example.com/",
    ctx: requestContext({ teamId: "test", zeroDataRetention: false }),
    state: {},
    options,
    internalOptions: { teamId: "test", orgId: null },
    featureFlags: new Set(featureFlags),
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

describe("Stealth proxy routing without fire-engine (buildFallbackList)", () => {
  let buildFallbackList: typeof BuildFallbackList;
  let replaceService: typeof ReplaceService | undefined;

  const overrides = {
    FIRE_ENGINE_BETA_URL: undefined,
    FIRE_EXCHANGE_URL: undefined,
    INDEX_DATABASE_URL: undefined,
    PLAYWRIGHT_MICROSERVICE_URL: "http://test-playwright",
  } satisfies Record<string, string | undefined>;
  const original: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const key of Object.keys(overrides)) {
      original[key] = process.env[key];
    }
    setEnv(overrides);

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

  afterAll(() => {
    replaceService?.(undefined);
    setEnv(original);
  });

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
