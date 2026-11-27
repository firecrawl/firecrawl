import { describe, expect, it, vi } from "vitest";
import {
  buildSearchProviderRegistry,
  coreSearchProviderNames,
  coreSearchProviderSpecs,
} from "./search-providers";
import type { SearchProvider, SearchQuery } from "./search-providers";

const makeProvider = (
  name: string,
  overrides: {
    priority?: number;
    supportsUsOnly?: boolean;
    supportsZdr?: boolean;
    supportsAnon?: boolean;
    enabled?: () => boolean;
    search?: SearchProvider["search"];
  } = {},
): SearchProvider => ({
  // @ts-expect-error: test provider names exercise open declaration-merged SearchProviderName
  name,
  priority: 10,
  enabled: () => true,
  search: vi.fn(async () => ({ web: [] })),
  ...overrides,
});

describe("buildSearchProviderRegistry", () => {
  it("keeps registration order in all() and sorts enabled() by priority descending with registration-order tie-breaking", () => {
    let secondEnabled = false;
    const low = makeProvider("duckduckgo", { priority: 0 });
    const midFirst = makeProvider("searxng", {
      priority: 50,
      enabled: () => secondEnabled,
    });
    const midSecond = makeProvider("custom-mid", { priority: 50 });
    const high = makeProvider("primary", {
      priority: 100,
      supportsUsOnly: true,
    });
    const negative = makeProvider("fallback", { priority: -10 });

    const { registry, describedSearchProviders } = buildSearchProviderRegistry([
      { owner: "core", searchProviders: [low, midFirst, high] },
      { owner: "extra", searchProviders: [midSecond, negative] },
    ]);

    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.all())).toBe(true);
    expect(registry.all().map(p => p.name)).toEqual([
      "duckduckgo",
      "searxng",
      "primary",
      "custom-mid",
      "fallback",
    ]);
    expect(registry.enabled().map(p => p.name)).toEqual([
      "primary",
      "custom-mid",
      "duckduckgo",
      "fallback",
    ]);
    expect(Object.isFrozen(registry.enabled())).toBe(true);
    expect(registry.get("primary")?.supportsUsOnly).toBe(true);
    expect(registry.get("duckduckgo")?.supportsUsOnly).toBeUndefined();

    secondEnabled = true;
    expect(registry.enabled().map(p => p.name)).toEqual([
      "primary",
      "searxng",
      "custom-mid",
      "duckduckgo",
      "fallback",
    ]);
    expect(describedSearchProviders).toEqual({
      "custom-mid": { owner: "extra", priority: 50 },
      duckduckgo: { owner: "core", priority: 0 },
      fallback: { owner: "extra", priority: -10 },
      primary: { owner: "core", priority: 100 },
      searxng: { owner: "core", priority: 50 },
    });
  });

  it("never calls enabled() while building the registry or reading all() and get()", () => {
    const enabled = vi.fn(() => true);
    const { registry } = buildSearchProviderRegistry([
      {
        owner: "core",
        searchProviders: [makeProvider("searxng", { priority: 50, enabled })],
      },
    ]);

    expect(registry.all()).toHaveLength(1);
    expect(registry.get("searxng")?.priority).toBe(50);
    expect(enabled).not.toHaveBeenCalled();

    expect(registry.enabled()).toHaveLength(1);
    expect(enabled).toHaveBeenCalledTimes(1);
  });

  it("uses last-wins replacement while preserving the replaced provider's registration slot", async () => {
    const coreSearch = vi.fn(async () => ({ web: [] }));
    const overrideSearch = vi.fn(async () => ({
      web: [{ url: "https://example.com", title: "Example", description: "" }],
    }));

    const { registry, describedSearchProviders } = buildSearchProviderRegistry([
      {
        owner: "core",
        searchProviders: [
          makeProvider("searxng", {
            priority: 50,
            supportsUsOnly: true,
            search: coreSearch,
          }),
          makeProvider("peer", { priority: 50 }),
          makeProvider("duckduckgo", { priority: 0 }),
        ],
      },
      {
        owner: "override",
        searchProviders: [
          makeProvider("searxng", {
            priority: 50,
            supportsUsOnly: false,
            search: overrideSearch,
          }),
          makeProvider("custom", { priority: 200 }),
        ],
      },
    ]);

    expect(registry.all().map(p => p.name)).toEqual([
      "searxng",
      "peer",
      "duckduckgo",
      "custom",
    ]);
    expect(registry.enabled().map(p => p.name)).toEqual([
      "custom",
      "searxng",
      "peer",
      "duckduckgo",
    ]);
    expect(registry.get("searxng")?.supportsUsOnly).toBeUndefined();
    expect(describedSearchProviders).toEqual({
      custom: { owner: "override", priority: 200 },
      duckduckgo: { owner: "core", priority: 0 },
      peer: { owner: "core", priority: 50 },
      searxng: { owner: "override", priority: 50 },
    });

    const query: SearchQuery = { query: "firecrawl", numResults: 5 };
    await registry.get("searxng")?.search(query);
    expect(overrideSearch).toHaveBeenCalledWith(query);
    expect(coreSearch).not.toHaveBeenCalled();
  });

  it("re-sorts enabled() when an override changes a provider's priority", () => {
    const { registry } = buildSearchProviderRegistry([
      {
        owner: "core",
        searchProviders: [
          makeProvider("primary", { priority: 100 }),
          makeProvider("searxng", { priority: 50 }),
          makeProvider("duckduckgo", { priority: 0 }),
        ],
      },
      {
        owner: "override",
        searchProviders: [makeProvider("duckduckgo", { priority: 150 })],
      },
    ]);

    expect(registry.all().map(p => p.name)).toEqual([
      "primary",
      "searxng",
      "duckduckgo",
    ]);
    expect(registry.enabled().map(p => p.name)).toEqual([
      "duckduckgo",
      "primary",
      "searxng",
    ]);
  });

  it("snapshots provider fields at registration so later mutations have no effect", () => {
    const mutable = {
      name: "searxng" as const,
      priority: 50,
      supportsUsOnly: true,
      enabled: () => true,
      search: vi.fn(async () => null),
    };
    const list: Array<SearchProvider> = [mutable];

    const { registry } = buildSearchProviderRegistry([
      { owner: "core", searchProviders: list },
    ]);

    list.push(makeProvider("duckduckgo"));
    mutable.priority = -999;
    mutable.supportsUsOnly = false;

    const registered = registry.get("searxng");
    expect(registry.all()).toHaveLength(1);
    expect(Object.isFrozen(registered)).toBe(true);
    expect(registered?.priority).toBe(50);
    expect(registered?.supportsUsOnly).toBe(true);
  });

  it("binds enabled() and search() so class-based providers keep their this receiver", async () => {
    class StatefulProvider {
      readonly name = "searxng" as const;
      readonly priority = 75;
      private active = true;
      private readonly prefix = "stateful";

      enabled(): boolean {
        return this.active;
      }

      async search(query: SearchQuery) {
        return {
          web: [
            {
              url: `https://example.com/${this.prefix}/${query.query}`,
              title: this.prefix,
              description: "",
            },
          ],
        };
      }
    }

    const { registry } = buildSearchProviderRegistry([
      { owner: "core", searchProviders: [new StatefulProvider()] },
    ]);

    const provider = registry.get("searxng")!;
    const { enabled, search } = provider;
    expect(enabled()).toBe(true);
    expect(await search({ query: "hello", numResults: 3 })).toEqual({
      web: [
        {
          url: "https://example.com/stateful/hello",
          title: "stateful",
          description: "",
        },
      ],
    });
  });

  it("handles prototype property names safely", () => {
    const protoProvider = makeProvider("__proto__", { priority: 10 });
    const ctorProvider = makeProvider("constructor", { priority: 20 });

    const { registry, describedSearchProviders } = buildSearchProviderRegistry([
      { owner: "core", searchProviders: [protoProvider, ctorProvider] },
    ]);

    expect(registry.get("__proto__")?.name).toBe("__proto__");
    expect(registry.get("constructor")?.name).toBe("constructor");
    expect(registry.get("toString")).toBeUndefined();
    expect(registry.enabled().map(p => p.name)).toEqual([
      "constructor",
      "__proto__",
    ]);
    expect(Object.entries(describedSearchProviders)).toEqual([
      ["__proto__", { owner: "core", priority: 10 }],
      ["constructor", { owner: "core", priority: 20 }],
    ]);
    expect(describedSearchProviders).toEqual({
      ["__proto__"]: { owner: "core", priority: 10 },
      constructor: { owner: "core", priority: 20 },
    });
  });

  it("validates provider fields at registration time", () => {
    expect(() =>
      buildSearchProviderRegistry([
        { owner: "core", searchProviders: [makeProvider("")] },
      ]),
    ).toThrow("Search provider name must be a non-empty string");

    expect(() =>
      buildSearchProviderRegistry([
        {
          owner: "core",
          searchProviders: [makeProvider("searxng", { priority: Number.NaN })],
        },
      ]),
    ).toThrow('Search provider "searxng" priority must be a finite number');

    expect(() =>
      buildSearchProviderRegistry([
        {
          owner: "core",
          searchProviders: [
            makeProvider("searxng", { priority: Number.POSITIVE_INFINITY }),
          ],
        },
      ]),
    ).toThrow('Search provider "searxng" priority must be a finite number');

    expect(() =>
      buildSearchProviderRegistry([
        {
          owner: "core",
          searchProviders: [
            makeProvider("searxng", {
              // @ts-expect-error: verifying runtime rejection of non-function enabled
              enabled: "yes",
            }),
          ],
        },
      ]),
    ).toThrow('Search provider "searxng" enabled must be a function');

    expect(() =>
      buildSearchProviderRegistry([
        {
          owner: "core",
          searchProviders: [
            makeProvider("searxng", {
              // @ts-expect-error: verifying runtime rejection of null search
              search: null,
            }),
          ],
        },
      ]),
    ).toThrow('Search provider "searxng" search must be a function');

    expect(() =>
      buildSearchProviderRegistry([
        {
          owner: "core",
          searchProviders: [
            makeProvider("searxng", {
              // @ts-expect-error: verifying runtime rejection of non-boolean supportsUsOnly
              supportsUsOnly: "yes",
            }),
          ],
        },
      ]),
    ).toThrow('Search provider "searxng" supportsUsOnly must be a boolean');

    for (const flag of ["supportsZdr", "supportsAnon"] as const) {
      expect(() =>
        buildSearchProviderRegistry([
          {
            owner: "core",
            searchProviders: [makeProvider("searxng", { [flag]: 1 })],
          },
        ]),
      ).toThrow(`Search provider "searxng" ${flag} must be a boolean`);
    }
  });

  it("keeps declared mode support on the registered provider", () => {
    const { registry } = buildSearchProviderRegistry([
      {
        owner: "core",
        searchProviders: [
          makeProvider("primary", { supportsZdr: true, supportsAnon: true }),
          makeProvider("zdr-only", { supportsZdr: true, supportsAnon: false }),
          makeProvider("duckduckgo"),
        ],
      },
    ]);

    expect(registry.get("primary")?.supportsZdr).toBe(true);
    expect(registry.get("primary")?.supportsAnon).toBe(true);
    expect(registry.get("zdr-only")?.supportsZdr).toBe(true);
    expect(registry.get("zdr-only")?.supportsAnon).toBeUndefined();
    expect(registry.get("duckduckgo")?.supportsZdr).toBeUndefined();
    expect(registry.get("duckduckgo")?.supportsAnon).toBeUndefined();
  });

  it("lists all built-in search provider names and specs in default priority order", () => {
    expect(coreSearchProviderNames).toEqual(["searxng", "duckduckgo"]);
    expect(Object.isFrozen(coreSearchProviderNames)).toBe(true);
    expect(coreSearchProviderSpecs).toEqual([
      { name: "searxng", priority: 50 },
      { name: "duckduckgo", priority: 0 },
    ]);
    expect(Object.isFrozen(coreSearchProviderSpecs)).toBe(true);
  });
});
