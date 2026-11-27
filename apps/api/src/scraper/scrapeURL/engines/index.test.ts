import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "winston";
import type { z } from "zod";
import type {
  Engine as RegisteredEngine,
  EngineFeatureMap,
} from "../../../service/engines";
import { createService, replaceService } from "../../../service/service";
import type { InternalOptions, Meta } from "..";
import {
  buildFallbackList,
  coreEngineFeatures,
  coreEngines,
  getEngineMaxReasonableTime,
  scrapeURLWithEngine,
} from "./index";
import type { Engine, EngineScrapeResult, FeatureFlag } from "./index";
import { coreEngineSpecs } from "./metadata";
import { getScrapeMeta } from "../metaContext";
import { FormatUnavailableError } from "../../../lib/error";
import type { HookHandlers } from "../../../service/hooks";
import { scrapeOptions } from "../../../controllers/v2/types";
import { AbortManager } from "../lib/abortManager";
import { CostTracking } from "../../../lib/cost-tracking";

const makeFeatures = (
  listed: Record<string, { priority: number }>,
): EngineFeatureMap => listed;

const makeMeta = (
  overrides: {
    url?: string;
    featureFlags?: Array<FeatureFlag>;
    forceEngine?: Engine | Array<Engine>;
    maxAge?: number;
    lockdown?: boolean;
    formats?: z.input<typeof scrapeOptions>["formats"];
  } = {},
): Meta => {
  const logger = createLogger({ silent: true });
  vi.spyOn(logger, "info").mockReturnValue(logger);
  vi.spyOn(logger, "warn").mockReturnValue(logger);
  vi.spyOn(logger, "debug").mockReturnValue(logger);
  vi.spyOn(logger, "error").mockReturnValue(logger);
  vi.spyOn(logger, "child").mockReturnValue(logger);

  const options: Meta["options"] & { maxAge?: number; lockdown?: boolean } = {
    ...scrapeOptions.parse({
      formats: overrides.formats ?? [{ type: "markdown" }],
    }),
    skipTlsVerification: false,
    maxAge: overrides.maxAge ?? 0,
  };
  if (overrides.lockdown !== undefined) {
    options.lockdown = overrides.lockdown;
  }

  const internalOptions: InternalOptions = {
    teamId: "team-1",
    orgId: null,
  };
  if (overrides.forceEngine !== undefined) {
    internalOptions.forceEngine = overrides.forceEngine;
  }

  return {
    id: "test",
    url: overrides.url ?? "https://example.com",
    ctx: { teamId: "team-1", zeroDataRetention: false },
    state: {},
    options,
    internalOptions,
    logger,
    abort: new AbortManager(),
    featureFlags: new Set(overrides.featureFlags ?? []),
    mock: null,
    imageOcrEnabled: async () => false,
    pdfPrefetch: undefined,
    documentPrefetch: undefined,
    imagePrefetch: undefined,
    fetchPrefetch: undefined,
    costTracking: new CostTracking(),
    threatDecisions: [],
  };
};

const makeEngine = (
  name: string,
  overrides: {
    quality?: number;
    features?: Record<string, boolean>;
    enabled?: () => boolean;
    scrape?: RegisteredEngine["scrape"];
    maxReasonableTime?: RegisteredEngine["maxReasonableTime"];
    explicitOnly?: boolean;
    cache?: boolean;
    fileOnly?: boolean;
    supportsProfile?: boolean;
    prefetchesFiles?: boolean;
    allowEmptyContent?: boolean;
  } = {},
): RegisteredEngine => ({
  // @ts-expect-error: test engine names exercise open declaration-merged EngineName
  name,
  quality: 10,
  features: {},
  enabled: () => true,
  scrape: vi.fn<RegisteredEngine["scrape"]>(),
  ...overrides,
});

const install = (
  engines: ReadonlyArray<RegisteredEngine>,
  engineFeatures: EngineFeatureMap = coreEngineFeatures,
  extensions: Array<{
    name: string;
    engines?: ReadonlyArray<RegisteredEngine>;
    engineFeatures?: EngineFeatureMap;
    hooks?: HookHandlers;
  }> = [],
) => {
  replaceService(
    createService(
      { modules: {}, extensions },
      {
        core: { name: "core", engines, engineFeatures },
        logger: { error: vi.fn() },
      },
    ),
  );
};

afterEach(() => {
  replaceService(undefined);
});

describe("engine registry integration", () => {
  it("matches every built-in spec in coreEngines", () => {
    expect(coreEngines.map(e => e.name)).toEqual(
      coreEngineSpecs.map(spec => spec.name),
    );
    for (const spec of coreEngineSpecs) {
      const engine = coreEngines.find(e => e.name === spec.name);
      expect(engine).toBeDefined();
      expect(engine?.quality).toBe(spec.quality);
      expect(engine?.features).toEqual(spec.features);
      expect(engine?.explicitOnly).toBe(spec.explicitOnly);
      expect(engine?.scrape.name).toBe(spec.method);
    }
  });

  it("selects contributed engines and scores contributed features at call time", async () => {
    let customEnabled = false;
    const customEngine = makeEngine("custom;fast", {
      quality: 80,
      features: { customFeature: true },
      enabled: () => customEnabled,
    });
    const fallbackEngine = makeEngine("fetch", {
      quality: 5,
      features: {},
    });

    install([fallbackEngine], coreEngineFeatures, [
      {
        name: "extra",
        engines: [customEngine],
        engineFeatures: makeFeatures({
          customFeature: { priority: 100 },
        }),
      },
    ]);

    const before = await buildFallbackList(makeMeta());
    expect(before.map(e => e.engine)).toEqual(["fetch"]);

    customEnabled = true;
    const after = await buildFallbackList(
      makeMeta({
        featureFlags: [
          // @ts-expect-error: test feature name exercises open declaration-merged EngineFeatureName
          "customFeature",
        ],
      }),
    );
    expect(after.map(e => e.engine)).toEqual(["custom;fast"]);
    expect([...after[0].unsupportedFeatures]).toEqual([]);
  });

  it("keeps explicitOnly engines out of the default waterfall but honors forceEngine", async () => {
    const explicitEngine = makeEngine("custom;explicit", {
      quality: 2000,
      explicitOnly: true,
    });
    install([makeEngine("fetch", { quality: 5 }), explicitEngine]);

    const normal = await buildFallbackList(makeMeta());
    expect(normal.map(e => e.engine)).toEqual(["fetch"]);

    const forced = await buildFallbackList(
      makeMeta({ forceEngine: explicitEngine.name }),
    );
    expect(forced.map(e => e.engine)).toEqual(["custom;explicit"]);
  });

  it("honors last-wins engine replacement during selection and dispatch", async () => {
    const coreScrape = vi.fn();
    const overrideResult: EngineScrapeResult = {
      url: "https://example.com",
      html: "<p>override</p>",
      statusCode: 200,
      proxyUsed: "basic",
    };
    async function scrapeWithOverride(): Promise<EngineScrapeResult> {
      return overrideResult;
    }

    install(
      [makeEngine("fetch", { quality: 5, scrape: coreScrape })],
      coreEngineFeatures,
      [
        {
          name: "override",
          engines: [
            makeEngine("fetch", {
              quality: 75,
              features: { stealthProxy: true },
              scrape: scrapeWithOverride,
              maxReasonableTime: () => 9000,
            }),
          ],
        },
      ],
    );

    const meta = makeMeta();
    const result = await scrapeURLWithEngine(meta, "fetch");

    expect(result).toBe(overrideResult);
    expect(coreScrape).not.toHaveBeenCalled();
    expect(meta.logger.child).toHaveBeenCalledWith({
      method: "scrapeWithOverride",
      engine: "fetch",
    });
    expect(getEngineMaxReasonableTime(meta, "fetch")).toBe(9000);
  });

  it("adds stealthProxy to meta.featureFlags when the engine supports it and is not a cache engine", async () => {
    const receivedFlags: Array<Array<FeatureFlag>> = [];
    const stealthEngine = makeEngine("custom;stealth", {
      features: { stealthProxy: true },
      scrape: async meta => {
        receivedFlags.push([...meta.featureFlags]);
        return {
          url: meta.url,
          html: "",
          statusCode: 200,
          proxyUsed: "stealth",
        };
      },
    });
    const cacheEngine = makeEngine("custom;cache", {
      cache: true,
      features: { stealthProxy: true },
      scrape: async meta => {
        receivedFlags.push([...meta.featureFlags]);
        return {
          url: meta.url,
          html: "",
          statusCode: 200,
          proxyUsed: "basic",
        };
      },
    });
    install([stealthEngine, cacheEngine]);

    await scrapeURLWithEngine(makeMeta(), stealthEngine.name);
    await scrapeURLWithEngine(makeMeta(), cacheEngine.name);

    expect(receivedFlags).toEqual([["stealthProxy"], []]);
  });

  it("skips unregistered forced engines with a warning and fails on unregistered features or dispatch", async () => {
    install([makeEngine("fetch", { quality: 5 })]);

    const meta = makeMeta({
      forceEngine: [
        // @ts-expect-error: deliberately passing an unregistered engine name to verify warning behavior
        "missing",
        "fetch",
      ],
    });
    const list = await buildFallbackList(meta);
    expect(list.map(e => e.engine)).toEqual(["fetch"]);
    expect(meta.logger.warn).toHaveBeenCalledWith(
      "Skipping unregistered engine",
      { engine: "missing" },
    );

    await expect(
      buildFallbackList(
        makeMeta({
          featureFlags: [
            // @ts-expect-error: deliberately passing an unregistered feature name to verify rejection
            "unregisteredFeature",
          ],
        }),
      ),
    ).rejects.toThrow(
      'Engine feature "unregisteredFeature" is not registered on the service',
    );

    await expect(
      scrapeURLWithEngine(
        makeMeta(),
        // @ts-expect-error: deliberately passing an unregistered engine name to verify rejection
        "missing",
      ),
    ).rejects.toThrow('Engine "missing" is not registered on the service');
  });

  it("falls back to 30000ms with a warning when an engine has no maxReasonableTime", () => {
    install([makeEngine("fetch", { maxReasonableTime: undefined })]);

    const meta = makeMeta();
    expect(getEngineMaxReasonableTime(meta, "fetch")).toBe(30_000);
    expect(meta.logger.warn).toHaveBeenCalledWith("No MRT for engine", {
      engine: "fetch",
    });
  });

  it("gates cache-trait engines on fresh-scrape options outside lockdown", async () => {
    install([
      makeEngine("custom;cache", { quality: 1000, cache: true }),
      makeEngine("fetch", { quality: 5 }),
    ]);

    const fresh = await buildFallbackList(makeMeta({ maxAge: 0 }));
    expect(fresh.map(e => e.engine)).toEqual(["fetch"]);

    const cached = await buildFallbackList(makeMeta({ maxAge: 60_000 }));
    expect(cached.map(e => e.engine)).toEqual(["custom;cache", "fetch"]);

    const customScreenshot = await buildFallbackList(
      makeMeta({
        maxAge: 60_000,
        formats: [{ type: "screenshot", quality: 80 }],
      }),
    );
    expect(customScreenshot.map(e => e.engine)).toEqual(["fetch"]);

    const lockedDown = await buildFallbackList(
      makeMeta({ maxAge: 0, lockdown: true }),
    );
    expect(lockedDown.map(e => e.engine)).toEqual(["custom;cache"]);
  });

  it("uses fileOnly rather than pdf/document features when deciding stealth scoring", async () => {
    install([
      makeEngine("browser;basic", { quality: 50, features: {} }),
      makeEngine("browser;stealth-hybrid", {
        quality: 10,
        features: { stealthProxy: true, pdf: true },
      }),
      makeEngine("pdf", {
        quality: -20,
        fileOnly: true,
        features: { pdf: true, stealthProxy: true },
      }),
    ]);

    const hybrid = await buildFallbackList(
      makeMeta({ featureFlags: ["stealthProxy"] }),
    );
    expect(hybrid.map(e => e.engine)).toEqual(["browser;stealth-hybrid"]);

    install([
      makeEngine("browser;basic", { quality: 50, features: {} }),
      makeEngine("pdf", {
        quality: -20,
        fileOnly: true,
        features: { pdf: true, stealthProxy: true },
      }),
    ]);

    const fileOnlyStealth = await buildFallbackList(
      makeMeta({ featureFlags: ["stealthProxy"] }),
    );
    expect(fileOnlyStealth.map(e => e.engine)).toEqual(["browser;basic"]);
  });

  it("allows a follow-up scrape.engines.select hook to enforce a capability gate after suppressUnsupportedWarnings", async () => {
    let seenMeta: Meta | undefined;
    class CustomFormatError extends FormatUnavailableError {
      constructor(message: string) {
        super("custom", "UNKNOWN_ERROR", message, message);
      }
    }
    install([makeEngine("fetch", { quality: 5 })], coreEngineFeatures, [
      {
        name: "selector",
        hooks: {
          "scrape.engines.select": (plan, info) => {
            seenMeta = getScrapeMeta(info);
            return {
              candidates: ["fetch"],
              suppressUnsupportedWarnings: true,
            };
          },
        },
      },
      {
        name: "gate",
        hooks: {
          "scrape.engines.select": () => {
            throw new CustomFormatError("Format not supported");
          },
        },
      },
    ]);

    const meta = makeMeta({
      featureFlags: [],
      formats: [{ type: "markdown" }],
    });
    await expect(buildFallbackList(meta)).rejects.toBeInstanceOf(
      CustomFormatError,
    );
    expect(seenMeta).toBe(meta);
  });
});
