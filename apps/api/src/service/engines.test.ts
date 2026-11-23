import { describe, expect, it, vi } from "vitest";
import {
  buildEngineRegistry,
  type Engine,
  type EngineFeatureMap,
} from "./engines";

const makeEngine = (
  name: string,
  overrides: {
    quality?: number;
    features?: Record<string, boolean | undefined>;
    enabled?: () => boolean;
    scrape?: Engine["scrape"];
    maxReasonableTime?: Engine["maxReasonableTime"];
    explicitOnly?: boolean;
  } = {},
): Engine =>
  ({
    name,
    quality: 10,
    features: {},
    enabled: () => true,
    scrape: vi.fn(),
    ...overrides,
  }) as unknown as Engine;

const makeFeatures = (listed: Record<string, { priority: number }>) =>
  listed as unknown as EngineFeatureMap;

describe("buildEngineRegistry", () => {
  it("collects engines and features in registration order and returns frozen snapshots", () => {
    const first = makeEngine("alpha", {
      quality: 50,
      features: { waitFor: true, pdf: undefined },
    });
    const second = makeEngine("beta", {
      quality: -5,
      explicitOnly: true,
      features: { stealthProxy: true },
    });

    const { registry, describedEngines, describedFeatures } =
      buildEngineRegistry([
        {
          owner: "core",
          engines: [first],
          engineFeatures: makeFeatures({ waitFor: { priority: 1 } }),
        },
        {
          owner: "extra",
          engines: [second],
          engineFeatures: makeFeatures({ customFlag: { priority: 40 } }),
        },
      ]);

    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.all())).toBe(true);
    expect(Object.isFrozen(registry.features())).toBe(true);
    expect(registry.all().map(e => e.name)).toEqual(["alpha", "beta"]);
    expect(Object.isFrozen(registry.get("alpha"))).toBe(true);
    expect(Object.isFrozen(registry.get("alpha")?.features)).toBe(true);
    expect(registry.get("alpha")?.features).toEqual({ waitFor: true });
    expect(registry.get("beta")?.explicitOnly).toBe(true);
    expect(registry.feature("waitFor")).toEqual({ priority: 1 });
    expect(registry.feature("customFlag")).toEqual({ priority: 40 });
    expect(Object.isFrozen(registry.feature("customFlag"))).toBe(true);
    expect(describedEngines).toEqual({ alpha: "core", beta: "extra" });
    expect(describedFeatures).toEqual({
      customFlag: { owner: "extra", priority: 40 },
      waitFor: { owner: "core", priority: 1 },
    });
  });

  it("evaluates enabled() live at call time and never during build, all(), or get()", () => {
    let active = false;
    const enabled = vi.fn(() => active);
    const dynamic = makeEngine("dynamic", { enabled });

    const { registry } = buildEngineRegistry([
      { owner: "core", engines: [dynamic] },
    ]);

    expect(registry.all().map(e => e.name)).toEqual(["dynamic"]);
    expect(registry.get("dynamic")?.name).toBe("dynamic");
    expect(enabled).not.toHaveBeenCalled();

    expect(registry.enabled()).toEqual([]);
    expect(enabled).toHaveBeenCalledTimes(1);

    active = true;
    const running = registry.enabled();
    expect(Object.isFrozen(running)).toBe(true);
    expect(running.map(e => e.name)).toEqual(["dynamic"]);
    expect(enabled).toHaveBeenCalledTimes(2);
  });

  it("uses last-wins replacement for engines and features while preserving engine slot order", () => {
    const coreScrape = vi.fn();
    const overrideScrape = vi.fn();

    const { registry, describedEngines, describedFeatures } =
      buildEngineRegistry([
        {
          owner: "core",
          engines: [
            makeEngine("first", { quality: 10, scrape: coreScrape }),
            makeEngine("second", { quality: 20 }),
          ],
          engineFeatures: makeFeatures({
            waitFor: { priority: 1 },
            mobile: { priority: 10 },
          }),
        },
        {
          owner: "override",
          engines: [
            makeEngine("first", {
              quality: 99,
              features: { mobile: true },
              scrape: overrideScrape,
            }),
            makeEngine("third", { quality: 5 }),
          ],
          engineFeatures: makeFeatures({
            waitFor: { priority: 25 },
          }),
        },
      ]);

    expect(registry.all().map(e => e.name)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(registry.get("first")?.quality).toBe(99);
    expect(registry.get("first")?.scrape).toBe(overrideScrape);
    expect(registry.get("first")?.features).toEqual({ mobile: true });
    expect(registry.feature("waitFor")).toEqual({ priority: 25 });
    expect(registry.feature("mobile")).toEqual({ priority: 10 });
    expect(describedEngines).toEqual({
      first: "override",
      second: "core",
      third: "override",
    });
    expect(describedFeatures).toEqual({
      mobile: { owner: "core", priority: 10 },
      waitFor: { owner: "override", priority: 25 },
    });
  });

  it("snapshots caller inputs so later mutations cannot alter the registry", () => {
    const features: Record<string, boolean> = { waitFor: true };
    const input = makeEngine("snap", { quality: 10, features });
    const engines = [input];
    const featureEntry = { priority: 10 };
    const engineFeatures = makeFeatures({ waitFor: featureEntry });

    const { registry } = buildEngineRegistry([
      { owner: "core", engines, engineFeatures },
    ]);

    features.waitFor = false;
    features.pdf = true;
    engines.push(makeEngine("added"));
    featureEntry.priority = 999;

    expect(registry.all().map(e => e.name)).toEqual(["snap"]);
    expect(registry.get("snap")?.features).toEqual({ waitFor: true });
    expect(registry.feature("waitFor")).toEqual({ priority: 10 });
  });

  it("returns undefined for unregistered names and treats prototype keys as ordinary names", () => {
    const { registry, describedEngines, describedFeatures } =
      buildEngineRegistry([
        {
          owner: "core",
          engines: [
            makeEngine("__proto__", { features: { ["__proto__"]: true } }),
          ],
          engineFeatures: makeFeatures({
            ["__proto__"]: { priority: 0 },
            constructor: { priority: 15 },
          }),
        },
      ]);

    expect(registry.get("missing")).toBeUndefined();
    expect(registry.get("constructor")).toBeUndefined();
    expect(registry.get("toString")).toBeUndefined();
    expect(registry.get("")).toBeUndefined();
    expect(registry.feature("missing")).toBeUndefined();
    expect(registry.feature("toString")).toBeUndefined();
    expect(registry.feature("")).toBeUndefined();

    expect(registry.get("__proto__")?.name).toBe("__proto__");
    expect(
      Object.hasOwn(registry.get("__proto__")!.features, "__proto__"),
    ).toBe(true);
    expect(registry.feature("__proto__")).toEqual({ priority: 0 });
    expect(registry.feature("constructor")).toEqual({ priority: 15 });
    expect(Object.entries(describedEngines)).toEqual([["__proto__", "core"]]);
    expect(Object.entries(describedFeatures)).toEqual([
      ["__proto__", { owner: "core", priority: 0 }],
      ["constructor", { owner: "core", priority: 15 }],
    ]);
  });

  it("rejects malformed engines and invalid feature priority", () => {
    for (const badName of ["", 123 as unknown as string]) {
      expect(() =>
        buildEngineRegistry([
          { owner: "core", engines: [makeEngine(badName)] },
        ]),
      ).toThrow("Engine name must be a non-empty string");
    }

    expect(() =>
      buildEngineRegistry([
        {
          owner: "core",
          engines: [
            makeEngine("bad-enabled", {
              enabled: true as unknown as () => boolean,
            }),
          ],
        },
      ]),
    ).toThrow('Engine "bad-enabled" enabled must be a function');

    expect(() =>
      buildEngineRegistry([
        {
          owner: "core",
          engines: [
            makeEngine("bad-scrape", {
              scrape: null as unknown as Engine["scrape"],
            }),
          ],
        },
      ]),
    ).toThrow('Engine "bad-scrape" scrape must be a function');

    expect(() =>
      buildEngineRegistry([
        {
          owner: "core",
          engines: [
            makeEngine("bad-mrt", {
              maxReasonableTime:
                30000 as unknown as Engine["maxReasonableTime"],
            }),
          ],
        },
      ]),
    ).toThrow('Engine "bad-mrt" maxReasonableTime must be a function');

    for (const quality of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(() =>
        buildEngineRegistry([
          { owner: "core", engines: [makeEngine("bad", { quality })] },
        ]),
      ).toThrow('Engine "bad" quality must be a finite number');
    }

    for (const priority of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        buildEngineRegistry([
          {
            owner: "core",
            engineFeatures: makeFeatures({ bad: { priority } }),
          },
        ]),
      ).toThrow(
        'Engine feature "bad" priority must be a non-negative finite number',
      );
    }
  });
});
