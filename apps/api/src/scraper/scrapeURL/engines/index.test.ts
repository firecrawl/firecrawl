import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Engine as RegisteredEngine,
  EngineFeatureMap,
} from "../../../service/engines";
import { createService, replaceService } from "../../../service/service";
import type { Meta } from "..";
import {
  buildFallbackList,
  coreEngineFeatures,
  coreEngines,
  getEngineMaxReasonableTime,
  scrapeURLWithEngine,
  type Engine,
  type EngineScrapeResult,
  type FeatureFlag,
} from "./index";
import { coreEngineSpecs } from "./metadata";

vi.mock("../../WebScraper/utils/blocklist", () => ({
  isUrlBlocked: vi.fn(() => false),
}));

const makeMeta = (
  overrides: {
    url?: string;
    featureFlags?: FeatureFlag[];
    forceEngine?: Engine | Engine[];
  } = {},
): Meta => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);

  return {
    id: "test",
    url: overrides.url ?? "https://example.com",
    options: {
      formats: [{ type: "markdown" }],
      maxAge: 0,
    },
    internalOptions: {
      teamId: "team-1",
      orgId: null,
      ...(overrides.forceEngine !== undefined
        ? { forceEngine: overrides.forceEngine }
        : {}),
    },
    featureFlags: new Set(overrides.featureFlags ?? []),
    mock: null,
    logger,
  } as unknown as Meta;
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
  } = {},
): RegisteredEngine =>
  ({
    name,
    quality: 10,
    features: {},
    enabled: () => true,
    scrape: vi.fn(),
    ...overrides,
  }) as unknown as RegisteredEngine;

const install = (
  engines: readonly RegisteredEngine[],
  engineFeatures: EngineFeatureMap = coreEngineFeatures,
  extensions: Array<{
    name: string;
    engines?: readonly RegisteredEngine[];
    engineFeatures?: EngineFeatureMap;
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
        engineFeatures: {
          customFeature: { priority: 100 },
        } as unknown as EngineFeatureMap,
      },
    ]);

    const before = await buildFallbackList(makeMeta());
    expect(before.map(e => e.engine)).toEqual(["fetch"]);

    customEnabled = true;
    const after = await buildFallbackList(
      makeMeta({ featureFlags: ["customFeature" as FeatureFlag] }),
    );
    expect(after.map(e => e.engine)).toEqual(["custom;fast"]);
    expect([...after[0].unsupportedFeatures]).toEqual([]);
  });

  it("keeps explicitOnly engines out of the default waterfall but honors forceEngine", async () => {
    install([
      makeEngine("fetch", { quality: 5 }),
      makeEngine("exchange", { quality: 2000, explicitOnly: true }),
    ]);

    const normal = await buildFallbackList(makeMeta());
    expect(normal.map(e => e.engine)).toEqual(["fetch"]);

    const forced = await buildFallbackList(
      makeMeta({ forceEngine: "exchange" }),
    );
    expect(forced.map(e => e.engine)).toEqual(["exchange"]);
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

  it("adds stealthProxy to meta.featureFlags when the engine supports it and is not an index engine", async () => {
    const receivedFlags: FeatureFlag[][] = [];
    install([
      makeEngine("custom;stealth", {
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
      }),
      makeEngine("index", {
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
      }),
    ]);

    await scrapeURLWithEngine(makeMeta(), "custom;stealth" as Engine);
    await scrapeURLWithEngine(makeMeta(), "index");

    expect(receivedFlags).toEqual([["stealthProxy"], []]);
  });

  it("skips unregistered forced engines with a warning and fails on unregistered features or dispatch", async () => {
    install([makeEngine("fetch", { quality: 5 })]);

    const meta = makeMeta({ forceEngine: ["missing" as Engine, "fetch"] });
    const list = await buildFallbackList(meta);
    expect(list.map(e => e.engine)).toEqual(["fetch"]);
    expect(meta.logger.warn).toHaveBeenCalledWith(
      "Skipping unregistered engine",
      { engine: "missing" },
    );

    await expect(
      buildFallbackList(
        makeMeta({ featureFlags: ["unregisteredFeature" as FeatureFlag] }),
      ),
    ).rejects.toThrow(
      'Engine feature "unregisteredFeature" is not registered on the service',
    );

    await expect(
      scrapeURLWithEngine(makeMeta(), "missing" as Engine),
    ).rejects.toThrow('Engine "missing" is not registered on the service');
  });

  it("falls back to 30000ms with a warning when an engine has no maxReasonableTime", () => {
    install([makeEngine("fetch", { maxReasonableTime: undefined })]);

    const meta = makeMeta();
    expect(getEngineMaxReasonableTime(meta, "fetch")).toBe(30000);
    expect(meta.logger.warn).toHaveBeenCalledWith("No MRT for engine", {
      engine: "fetch",
    });
  });
});
