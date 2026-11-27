import Module from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScrapeJobTimeoutError } from "../lib/error";
import { coreErrors } from "../lib/error-serde";
import { coreEngineSpecs } from "../scraper/scrapeURL/engines/metadata";
import { coreParts } from "./core-parts";
import { defaultModules } from "./defaults";
import type { Engine } from "./engines";
import { coreLlmProviderNames } from "./llm-providers";
import type { LlmModel, LlmProvider } from "./llm-providers";
import { coreSearchProviderSpecs } from "./search-providers";
import type { SearchProvider } from "./search-providers";
import { hookPointNames } from "./hooks";
import { createService } from "./service";

type V4Model = Extract<LlmModel, { specificationVersion: "v4" }>;

const fakeModel = (id: string): LlmModel => ({
  specificationVersion: "v4",
  provider: "test",
  modelId: id,
  supportedUrls: {},
  doGenerate: vi.fn<V4Model["doGenerate"]>(),
  doStream: vi.fn<V4Model["doStream"]>(),
});

const loadedSideEffectModules = vi.hoisted(() => [] as Array<string>);
vi.mock("../config", () => {
  loadedSideEffectModules.push("config");
  return { config: {} };
});
vi.mock("../services/worker/nuq-router", () => {
  loadedSideEffectModules.push("nuq-router");
  return {};
});
vi.mock("../lib/crawl-redis", () => {
  loadedSideEffectModules.push("crawl-redis");
  return {};
});
vi.mock("../services/redis", () => {
  loadedSideEffectModules.push("redis");
  return {};
});
vi.mock("../services/queue-service", () => {
  loadedSideEffectModules.push("queue-service");
  return {};
});

const errorClassesModule = "../lib/error-serde";
const enginesModule = "../scraper/scrapeURL/engines";
const searchProvidersModule = "../search/providers";
const llmProvidersModule = "../lib/generic-ai";
const v2TypesModule = "../controllers/v2/types";

// coreParts() loads its error classes, engine implementations, search provider
// implementations, and LLM provider implementations with require() on first
// use. The test runner cannot resolve a source file loaded that way, so those
// loads are answered with stub modules.
function answerRequire(
  mockEngines?: ReadonlyArray<Engine>,
  mockLlmProviders?: ReadonlyArray<LlmProvider>,
  mockSearchProviders?: ReadonlyArray<SearchProvider>,
) {
  const load = Module.prototype.require;
  const enginesStub = mockEngines
    ? { coreEngines: mockEngines }
    : {
        coreEngines: coreEngineSpecs.map(spec => {
          const base = {
            name: spec.name,
            quality: spec.quality,
            features: spec.features,
            enabled: vi.fn(() => true),
            scrape: vi.fn<Engine["scrape"]>(),
            maxReasonableTime: vi.fn(() => 12_345),
          };
          return spec.explicitOnly ? { ...base, explicitOnly: true } : base;
        }),
      };
  const searchProvidersStub = mockSearchProviders
    ? { coreSearchProviders: mockSearchProviders }
    : {
        coreSearchProviders: coreSearchProviderSpecs.map(spec => {
          const base = {
            name: spec.name,
            priority: spec.priority,
            enabled: vi.fn(() => true),
            search: vi.fn(async () => ({ web: [] })),
          };
          return spec.supportsUsOnly ? { ...base, supportsUsOnly: true } : base;
        }),
      };
  const llmProvidersStub = mockLlmProviders
    ? { coreLlmProviders: mockLlmProviders }
    : {
        coreLlmProviders: coreLlmProviderNames.map(name => ({
          name,
          enabled: vi.fn(() => true),
          model: vi.fn((id: string) => fakeModel(id)),
        })),
      };
  const v2TypesStub = {
    buildV2RequestSchemas: vi.fn(() => {
      const fakeSchema = { _zod: {}, safeParse: vi.fn() };
      return {
        scrape: fakeSchema,
        parse: fakeSchema,
        crawl: fakeSchema,
        batchScrape: fakeSchema,
        batchScrapeNoURLValidation: fakeSchema,
        map: fakeSchema,
        search: fakeSchema,
        scrapeOptions: fakeSchema,
      };
    }),
  };
  return vi.spyOn(Module.prototype, "require").mockImplementation(function (
    this: Module,
    id: string,
  ) {
    if (id === errorClassesModule) {
      return { coreErrors };
    }
    if (id === enginesModule) {
      return enginesStub;
    }
    if (id === searchProvidersModule) {
      return searchProvidersStub;
    }
    if (id === llmProvidersModule) {
      return llmProvidersStub;
    }
    if (id === v2TypesModule) {
      return v2TypesStub;
    }
    const loaded: unknown = load.call(this, id);
    return loaded;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("coreParts", () => {
  it("loads its error classes on the first lookup, and once", () => {
    const required = answerRequire();
    const built = createService({ modules: {} }, coreParts());

    expect(required).not.toHaveBeenCalledWith(errorClassesModule);
    expect(built.errors.classFor("SCRAPE_TIMEOUT")).toBe(ScrapeJobTimeoutError);
    expect(built.errors.classFor("NOT_A_CODE")).toBeUndefined();
    expect(
      required.mock.calls.filter(([id]) => id === errorClassesModule),
    ).toHaveLength(1);
  });

  it("loads its engine implementations on the first engine call, and once", async () => {
    const enabled = vi.fn(() => true);
    const scrape = vi.fn().mockResolvedValue({
      url: "https://example.com",
      html: "<p>ok</p>",
      statusCode: 200,
      proxyUsed: "basic",
    });
    const maxReasonableTime = vi.fn(() => 42_000);
    const mockEngines: Array<Engine> = coreEngineSpecs.map(spec => {
      const base: Engine = {
        name: spec.name,
        quality: spec.quality,
        features: spec.features,
        enabled: spec.name === "fetch" ? enabled : () => false,
        scrape: spec.name === "fetch" ? scrape : vi.fn<Engine["scrape"]>(),
        maxReasonableTime:
          spec.name === "fetch" ? maxReasonableTime : () => 30_000,
      };
      return spec.explicitOnly ? { ...base, explicitOnly: true } : base;
    });

    const required = answerRequire(mockEngines);
    const built = createService({ modules: {} }, coreParts());

    // Creating the service, inspecting registered engines, and calling
    // describe() must not load the engine implementations.
    expect(built.engines.all()).toHaveLength(coreEngineSpecs.length);
    const fetchEngine = built.engines.get("fetch");
    expect(fetchEngine?.scrape.name).toBe("scrapeURLWithFetch");
    built.describe();
    expect(required).not.toHaveBeenCalledWith(enginesModule);

    expect(built.engines.enabled().map(e => e.name)).toEqual(["fetch"]);
    expect(enabled).toHaveBeenCalledTimes(1);

    const stubMeta = {};
    // @ts-expect-error: lazy engine wrapper only forwards the opaque meta object to the mock engine
    await fetchEngine!.scrape(stubMeta);
    expect(scrape).toHaveBeenCalledWith(stubMeta);
    // @ts-expect-error: lazy engine wrapper only forwards the opaque meta object to the mock engine
    expect(fetchEngine!.maxReasonableTime?.(stubMeta)).toBe(42_000);
    expect(maxReasonableTime).toHaveBeenCalledWith(stubMeta);
    expect(
      required.mock.calls.filter(([id]) => id === enginesModule),
    ).toHaveLength(1);
  });

  it("loads its LLM provider implementations on the first provider call, and once", () => {
    const enabled = vi.fn(() => true);
    const stubModel = fakeModel("gpt-4o-mini");
    const model = vi.fn(() => stubModel);
    const mockProviders: Array<LlmProvider> = coreLlmProviderNames.map(
      name => ({
        name,
        enabled: name === "openai" ? enabled : () => false,
        model: name === "openai" ? model : vi.fn(() => stubModel),
      }),
    );

    const required = answerRequire(undefined, mockProviders);
    const built = createService({ modules: {} }, coreParts());

    // Creating the service, inspecting registered providers, and calling
    // describe() must not load the provider implementations.
    expect(built.llmProviders.all()).toHaveLength(coreLlmProviderNames.length);
    const openaiProvider = built.llmProviders.get("openai");
    expect(openaiProvider?.name).toBe("openai");
    built.describe();
    expect(required).not.toHaveBeenCalledWith(llmProvidersModule);

    expect(built.llmProviders.enabled().map(p => p.name)).toEqual(["openai"]);
    expect(enabled).toHaveBeenCalledTimes(1);

    const opts = { feature: "Extract" };
    expect(openaiProvider!.model("gpt-4o-mini", opts)).toBe(stubModel);
    expect(model).toHaveBeenCalledWith("gpt-4o-mini", opts);
    expect(
      required.mock.calls.filter(([id]) => id === llmProvidersModule),
    ).toHaveLength(1);
  });

  it("loads its search provider implementations on the first provider call, and once", async () => {
    const enabled = vi.fn(() => true);
    const searchResult = {
      web: [{ url: "https://example.com", title: "Example", description: "" }],
    };
    const search = vi.fn(async () => searchResult);
    const mockProviders: Array<SearchProvider> = coreSearchProviderSpecs.map(
      spec => {
        const base: SearchProvider = {
          name: spec.name,
          priority: spec.priority,
          enabled: spec.name === "searxng" ? enabled : () => false,
          search: spec.name === "searxng" ? search : vi.fn(async () => null),
        };
        return spec.supportsUsOnly ? { ...base, supportsUsOnly: true } : base;
      },
    );

    const required = answerRequire(undefined, undefined, mockProviders);
    const built = createService({ modules: {} }, coreParts());

    // Creating the service, inspecting registered providers, and calling
    // describe() must not load the search provider implementations.
    expect(built.searchProviders.all().map(p => p.name)).toEqual([
      "searxng",
      "duckduckgo",
    ]);
    const searxngProvider = built.searchProviders.get("searxng");
    expect(searxngProvider?.priority).toBe(50);
    expect(searxngProvider?.supportsUsOnly).toBeUndefined();
    const duckduckgoProvider = built.searchProviders.get("duckduckgo");
    expect(duckduckgoProvider?.priority).toBe(0);
    expect(duckduckgoProvider?.supportsUsOnly).toBeUndefined();
    built.describe();
    expect(required).not.toHaveBeenCalledWith(searchProvidersModule);

    expect(built.searchProviders.enabled().map(p => p.name)).toEqual([
      "searxng",
    ]);
    expect(enabled).toHaveBeenCalledTimes(1);

    const query = { query: "firecrawl", numResults: 5 };
    expect(await searxngProvider!.search(query)).toBe(searchResult);
    expect(search).toHaveBeenCalledWith(query);
    expect(
      required.mock.calls.filter(([id]) => id === searchProvidersModule),
    ).toHaveLength(1);
  });

  it("preserves the handler method name on every built-in engine wrapper", () => {
    const built = createService({ modules: {} }, coreParts());

    for (const spec of coreEngineSpecs) {
      expect(built.engines.get(spec.name)?.scrape.name).toBe(spec.method);
    }
  });

  it("gives the service every process role, engine, feature, and error class", () => {
    const required = answerRequire();
    const built = createService({ modules: {} }, coreParts());

    expect(built.describe()).toEqual({
      extensions: ["core"],
      modules: [
        "auth",
        "billing",
        "blocklist",
        "idempotency",
        "jobStore",
        "limits",
        "messages",
        "policy",
        "uploads",
        "webhooks",
      ],
      hooks: {},
      errors: {
        AGENT_INDEX_ONLY: "core",
        CONCURRENCY_QUEUE_TIMEOUT: "core",
        CRAWL_DENIAL: "core",
        MAP_FAILED: "core",
        MAP_TIMEOUT: "core",
        RESERVED_CAPACITY_UNAVAILABLE: "core",
        SCRAPE_ACTIONS_NOT_SUPPORTED: "core",
        SCRAPE_ACTION_ERROR: "core",
        SCRAPE_ALL_ENGINES_FAILED: "core",
        SCRAPE_DNS_RESOLUTION_ERROR: "core",
        SCRAPE_DOCUMENT_ANTIBOT_ERROR: "core",
        SCRAPE_DOCUMENT_FETCH_PROXY_ERROR: "core",
        SCRAPE_DOCUMENT_PREFETCH_FAILED: "core",
        SCRAPE_JOB_CANCELLED: "core",
        SCRAPE_JSON_CONTENT_TOO_LARGE: "core",
        SCRAPE_LOCKDOWN_CACHE_MISS: "core",
        SCRAPE_NO_CACHED_DATA: "core",
        SCRAPE_PAYWALLED_CONTENT: "core",
        SCRAPE_PDF_ANTIBOT_ERROR: "core",
        SCRAPE_PDF_FETCH_PROXY_ERROR: "core",
        SCRAPE_PDF_INSUFFICIENT_TIME_ERROR: "core",
        SCRAPE_PDF_OCR_REQUIRED: "core",
        SCRAPE_PDF_PREFETCH_FAILED: "core",
        SCRAPE_PROMPT_INJECTION_DETECTED: "core",
        SCRAPE_PROXY_SELECTION_ERROR: "core",
        SCRAPE_RACED_REDIRECT_ERROR: "core",
        SCRAPE_RETRY_LIMIT: "core",
        SCRAPE_SITEMAP_ERROR: "core",
        SCRAPE_SITE_ERROR: "core",
        SCRAPE_SITE_RESTRICTION_BLOCKED: "core",
        SCRAPE_SSL_ERROR: "core",
        SCRAPE_TIMEOUT: "core",
        SCRAPE_UNSUPPORTED_FILE_ERROR: "core",
        SCRAPE_ZDR_VIOLATION_ERROR: "core",
        THIRD_PARTY_DATA_ENRICHMENT_NOT_ENABLED: "core",
        THIRD_PARTY_DATA_NOT_ENABLED: "core",
        THIRD_PARTY_DATA_NOT_FOUND: "core",
        THIRD_PARTY_DATA_UNSUPPORTED_URL: "core",
        UNKNOWN_ERROR: "core",
        UNSUPPORTED_SITE: "core",
        US_ONLY_UNAVAILABLE: "core",
      },
      engines: {
        document: "core",
        fetch: "core",
        pdf: "core",
        playwright: "core",
        wikipedia: "core",
      },
      engineFeatures: {
        actions: { owner: "core", priority: 20 },
        atsv: { owner: "core", priority: 90 },
        disableAdblock: { owner: "core", priority: 10 },
        document: { owner: "core", priority: 100 },
        image: { owner: "core", priority: 100 },
        location: { owner: "core", priority: 10 },
        mobile: { owner: "core", priority: 10 },
        pdf: { owner: "core", priority: 100 },
        screenshot: { owner: "core", priority: 10 },
        "screenshot@fullScreen": { owner: "core", priority: 10 },
        skipTlsVerification: { owner: "core", priority: 10 },
        stealthProxy: { owner: "core", priority: 20 },
        useFastMode: { owner: "core", priority: 90 },
        waitFor: { owner: "core", priority: 1 },
      },
      searchProviders: {
        duckduckgo: { owner: "core", priority: 0 },
        searxng: { owner: "core", priority: 50 },
      },
      llmProviders: {
        ollama: "core",
        openai: "core",
      },
      request: {
        scrapeOptions: {},
        scrape: {},
        parse: {},
        crawl: {},
        batchScrape: {},
        map: {},
        search: {},
        formats: {},
        rules: [],
      },
      routes: [],
      roles: {
        api: "core",
        harness: "core",
        "nuq-fdb-worker": "core",
        "nuq-prefetch-worker": "core",
        "nuq-reconciler-worker": "core",
        "nuq-worker": "core",
        "queue-worker": "core",
      },
      env: {},
    });
    expect(required).not.toHaveBeenCalledWith(enginesModule);
    expect(required).not.toHaveBeenCalledWith(searchProvidersModule);
    expect(required).not.toHaveBeenCalledWith(llmProvidersModule);
    expect(required).not.toHaveBeenCalledWith(v2TypesModule);
  });

  it("loads v2 request schemas lazily on the first schemas access, and once", () => {
    const required = answerRequire();
    const built = createService({ modules: {} }, coreParts());

    built.describe();
    expect(required).not.toHaveBeenCalledWith(v2TypesModule);

    expect(built.schemas.scrape).toBeDefined();
    expect(built.schemas.parse).toBeDefined();
    expect(built.schemas.crawl).toBeDefined();
    expect(built.schemas.batchScrape).toBeDefined();
    expect(built.schemas.batchScrapeNoURLValidation).toBeDefined();
    expect(built.schemas.map).toBeDefined();
    expect(built.schemas.search).toBeDefined();
    expect(built.schemas.scrapeOptions).toBeDefined();
    expect(
      required.mock.calls.filter(([id]) => id === v2TypesModule),
    ).toHaveLength(1);
  });

  it("loads core error classes and default modules without loading configuration, queue, Redis, or database clients", () => {
    const required = answerRequire();
    const built = createService({ modules: defaultModules() }, coreParts());

    for (const name of hookPointNames) {
      expect(built.hooks.has(name)).toBe(false);
    }
    const links = ["https://example.com/a"];
    const transformed = built.hooks.transform("crawl.links", links, {
      id: "crawl-1",
      ctx: { teamId: "team-1", zeroDataRetention: false },
      from: "https://example.com",
    });
    expect(transformed).toBe(links);
    expect(transformed instanceof Promise).toBe(false);

    expect(built.describe().hooks).toEqual({});
    expect(built.describe().routes).toEqual([]);
    expect(built.roles.names()).toHaveLength(7);
    expect(built.roles.has("cclog-worker")).toBe(false);
    expect(built.roles.has("extract-worker")).toBe(false);
    expect(built.roles.has("index-worker")).toBe(false);
    expect(built.roles.has("zdr-worker")).toBe(false);
    expect(built.describe().modules).toEqual([
      "auth",
      "billing",
      "blocklist",
      "idempotency",
      "jobStore",
      "limits",
      "messages",
      "policy",
      "uploads",
      "webhooks",
    ]);
    expect(required).not.toHaveBeenCalledWith("express");
    expect(required).not.toHaveBeenCalledWith(enginesModule);
    expect(required).not.toHaveBeenCalledWith(searchProvidersModule);
    expect(required).not.toHaveBeenCalledWith(llmProvidersModule);
    expect(required).not.toHaveBeenCalledWith(v2TypesModule);
    expect(loadedSideEffectModules).toEqual([]);
  });

  it("registers only openai and ollama in core and accepts extension-contributed LLM providers without side effects", () => {
    const required = answerRequire();
    const customModel = fakeModel("custom-model");
    const customEnabled = vi.fn(() => true);
    const customProvider: LlmProvider = {
      // @ts-expect-error: test provider name exercises open declaration-merged LlmProviderName
      name: "custom-llm",
      enabled: customEnabled,
      model: vi.fn(() => customModel),
    };

    const built = createService(
      {
        modules: defaultModules(),
        extensions: [{ name: "extra-llm", llmProviders: [customProvider] }],
      },
      coreParts(),
    );

    expect(built.describe().llmProviders).toEqual({
      "custom-llm": "extra-llm",
      ollama: "core",
      openai: "core",
    });
    expect(built.llmProviders.all().map(p => p.name)).toEqual([
      "openai",
      "ollama",
      "custom-llm",
    ]);
    expect(built.llmProviders.get("custom-llm")?.model("m")).toBe(customModel);
    expect(customEnabled).not.toHaveBeenCalled();
    expect(required).not.toHaveBeenCalledWith(llmProvidersModule);
    expect(loadedSideEffectModules).toEqual([]);
  });

  it("registers extension search providers alongside core SearXNG and DuckDuckGo without loading implementations", () => {
    const required = answerRequire();
    const customEnabled = vi.fn(() => true);
    const customSearch = vi.fn(async () => ({ web: [] }));
    const built = createService(
      {
        modules: defaultModules(),
        extensions: [
          {
            name: "custom-search",
            searchProviders: [
              {
                // @ts-expect-error: test provider name exercises open declaration-merged SearchProviderName
                name: "custom-primary",
                priority: 100,
                supportsUsOnly: true,
                enabled: customEnabled,
                search: customSearch,
              },
            ],
          },
        ],
      },
      coreParts(),
    );

    expect(built.searchProviders.all().map(p => p.name)).toEqual([
      "searxng",
      "duckduckgo",
      "custom-primary",
    ]);
    expect(built.describe().searchProviders).toEqual({
      "custom-primary": { owner: "custom-search", priority: 100 },
      duckduckgo: { owner: "core", priority: 0 },
      searxng: { owner: "core", priority: 50 },
    });
    expect(customEnabled).not.toHaveBeenCalled();
    expect(required).not.toHaveBeenCalledWith(searchProvidersModule);
    expect(loadedSideEffectModules).toEqual([]);

    expect(built.searchProviders.enabled().map(p => p.name)).toEqual([
      "custom-primary",
      "searxng",
      "duckduckgo",
    ]);
    expect(customEnabled).toHaveBeenCalledTimes(1);
    expect(required).toHaveBeenCalledWith(searchProvidersModule);
  });

  it("registers extension worker roles alongside core roles without loading worker implementations", () => {
    const required = answerRequire();
    const customRun = vi.fn();
    const built = createService(
      {
        modules: defaultModules(),
        extensions: [
          {
            name: "custom-workers",
            workers: {
              "custom-worker": { run: customRun },
            },
          },
        ],
      },
      coreParts(),
    );

    expect(built.roles.has("custom-worker")).toBe(true);
    expect(built.roles.owner("custom-worker")).toBe("custom-workers");
    expect(built.roles.has("cclog-worker")).toBe(false);
    expect(built.roles.has("extract-worker")).toBe(false);
    expect(built.roles.has("index-worker")).toBe(false);
    expect(built.roles.has("zdr-worker")).toBe(false);
    expect(built.describe().roles).toEqual({
      api: "core",
      "custom-worker": "custom-workers",
      harness: "core",
      "nuq-fdb-worker": "core",
      "nuq-prefetch-worker": "core",
      "nuq-reconciler-worker": "core",
      "nuq-worker": "core",
      "queue-worker": "core",
    });
    expect(customRun).not.toHaveBeenCalled();
    expect(required).not.toHaveBeenCalledWith(enginesModule);
    expect(loadedSideEffectModules).toEqual([]);
  });
});
