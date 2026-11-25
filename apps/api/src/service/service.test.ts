import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TransportableErrorClass } from "../lib/error";
import type { Engine, EngineFeatureMap } from "./engines";
import type { HookHandlers } from "./hooks";
import type { LlmModel, LlmProvider } from "./llm-providers";
import type { SearchProvider } from "./search-providers";
import {
  createService,
  processRole,
  replaceService,
  run,
  runProcessStop,
  service,
  type CoreParts,
  type Extension,
  type Worker,
} from "./service";

const worker = (): Worker => ({ run: vi.fn() });
const parts = (core: Partial<Extension> = {}): CoreParts => ({
  core: { name: "core", ...core },
  logger: { error: vi.fn() },
});

// A test's codes are not in ErrorCodes, so a class can only be built through a cast.
const errorClass = (...codes: string[]) =>
  ({ codes, deserialize: vi.fn() }) as unknown as TransportableErrorClass;

// A test's engine and feature names are not in Engines/EngineFeatures, so they
// are built through casts.
const engine = (
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

const featureMap = (listed: Record<string, { priority: number }>) =>
  listed as unknown as EngineFeatureMap;

const llmProvider = (
  name: string,
  overrides: {
    enabled?: () => boolean;
    model?: LlmProvider["model"];
  } = {},
): LlmProvider =>
  ({
    name,
    enabled: () => true,
    model: vi.fn((id: string) => ({ modelId: id }) as unknown as LlmModel),
    ...overrides,
  }) as unknown as LlmProvider;

const searchProvider = (
  name: string,
  overrides: {
    priority?: number;
    supportsUsOnly?: boolean;
    enabled?: () => boolean;
    search?: SearchProvider["search"];
  } = {},
): SearchProvider =>
  ({
    name,
    priority: 10,
    enabled: () => true,
    search: vi.fn(async () => ({ web: [] })),
    ...overrides,
  }) as unknown as SearchProvider;

afterEach(() => {
  replaceService(undefined);
});

describe("createService", () => {
  it("returns a frozen service", () => {
    const built = createService(
      { modules: {} },
      parts({ workers: { api: worker() } }),
    );

    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.modules)).toBe(true);
    expect(Object.isFrozen(built.hooks)).toBe(true);
    expect(Object.isFrozen(built.errors)).toBe(true);
    expect(Object.isFrozen(built.engines)).toBe(true);
    expect(Object.isFrozen(built.searchProviders)).toBe(true);
    expect(Object.isFrozen(built.llmProviders)).toBe(true);
    expect(Object.isFrozen(built.schemas)).toBe(true);
    expect(Object.isFrozen(built.roles)).toBe(true);
    expect(Object.isFrozen(built.workers)).toBe(true);
  });

  it("lets a later extension replace a role of the same name", () => {
    const mine = worker();
    const built = createService(
      { modules: {}, extensions: [{ name: "mine", workers: { api: mine } }] },
      parts({ workers: { api: worker() } }),
    );

    expect(built.workers.api).toBe(mine);
  });

  it("refuses two extensions with one name", () => {
    expect(() =>
      createService(
        { modules: {}, extensions: [{ name: "mine" }, { name: "mine" }] },
        parts(),
      ),
    ).toThrow('Two extensions are named "mine"');
    expect(() =>
      createService({ modules: {}, extensions: [{ name: "core" }] }, parts()),
    ).toThrow('Two extensions are named "core"');
  });

  it("reports a failing observe handler to the logger and not to the caller", () => {
    const failure = new Error("failed");
    const logged = parts({
      hooks: {
        "map.finished": () => {
          throw failure;
        },
      },
    });
    const built = createService({ modules: {} }, logged);

    expect(built.hooks.has("map.finished")).toBe(true);
    expect(built.hooks.has("search.finished")).toBe(false);
    expect(() =>
      built.hooks.observe("map.finished", {
        id: "m1",
        ctx: { teamId: "t1", zeroDataRetention: false },
        urls: 3,
      }),
    ).not.toThrow();
    expect(logged.logger.error).toHaveBeenCalledWith("Hook handler failed", {
      hook: "map.finished",
      error: failure,
    });
  });

  it("runs process.stop handlers in reverse extension order and logs isolated errors", async () => {
    const failure = new Error("stop failed");
    const order: string[] = [];
    const logged = parts({
      hooks: {
        "process.stop": () => {
          order.push("core");
        },
      },
    });
    const built = createService(
      {
        modules: {},
        extensions: [
          {
            name: "first",
            hooks: {
              "process.stop": () => {
                order.push("first");
                throw failure;
              },
            },
          },
          {
            name: "second",
            hooks: {
              "process.stop": () => {
                order.push("second");
              },
            },
          },
        ],
      },
      logged,
    );

    await expect(
      built.hooks.run("process.stop", { role: "api" }),
    ).resolves.toBeUndefined();
    expect(order).toEqual(["second", "first", "core"]);
    expect(logged.logger.error).toHaveBeenCalledWith("Hook handler failed", {
      hook: "process.stop",
      error: failure,
    });
  });

  it("refuses unknown hook point names, prototype keys, and non-function handlers at startup", () => {
    expect(() =>
      createService(
        {
          modules: {},
          extensions: [
            {
              name: "bad-name",
              hooks: { "unknown.point": vi.fn() } as unknown as HookHandlers,
            },
          ],
        },
        parts(),
      ),
    ).toThrow('Unknown hook point "unknown.point"');

    expect(() =>
      createService(
        {
          modules: {},
          extensions: [
            {
              name: "ctor-key",
              hooks: { constructor: vi.fn() } as unknown as HookHandlers,
            },
          ],
        },
        parts(),
      ),
    ).toThrow('Unknown hook point "constructor"');

    const withProtoKey = Object.defineProperty({}, "__proto__", {
      value: vi.fn(),
      enumerable: true,
    });
    expect(() =>
      createService(
        {
          modules: {},
          extensions: [
            {
              name: "proto-key",
              hooks: withProtoKey as unknown as HookHandlers,
            },
          ],
        },
        parts(),
      ),
    ).toThrow('Unknown hook point "__proto__"');

    expect(() =>
      createService(
        {
          modules: {},
          extensions: [
            {
              name: "bad-handler",
              hooks: { "map.finished": "not-a-fn" } as unknown as HookHandlers,
            },
          ],
        },
        parts(),
      ),
    ).toThrow('Hook "map.finished" handler must be a function');
  });
});

describe("errors", () => {
  it("finds the class registered under a code, whichever extension lists it", () => {
    const timeout = errorClass("TIMEOUT");
    const refusal = errorClass("NOT_FOUND", "NOT_ENABLED");
    const built = createService(
      { modules: {}, extensions: [{ name: "mine", errors: [refusal] }] },
      parts({ errors: [timeout] }),
    );

    expect(built.errors.classFor("TIMEOUT")).toBe(timeout);
    expect(built.errors.classFor("NOT_FOUND")).toBe(refusal);
    expect(built.errors.classFor("NOT_ENABLED")).toBe(refusal);
  });

  it("has no class for a code that nobody registered", () => {
    const built = createService(
      { modules: {} },
      parts({ errors: [errorClass("TIMEOUT")] }),
    );

    expect(built.errors.classFor("SOMETHING_ELSE")).toBeUndefined();
    expect(built.errors.classFor("constructor")).toBeUndefined();
    expect(built.errors.classFor("")).toBeUndefined();
  });

  it("takes any name for a code", () => {
    const inherited = errorClass("__proto__", "constructor");
    const built = createService(
      { modules: {} },
      parts({ errors: [inherited] }),
    );

    expect(built.errors.classFor("__proto__")).toBe(inherited);
    expect(built.errors.classFor("constructor")).toBe(inherited);
    expect(Object.entries(built.describe().errors)).toEqual([
      ["__proto__", "core"],
      ["constructor", "core"],
    ]);
  });

  it("calls a function that lists classes on the first lookup, and once", () => {
    const timeout = errorClass("TIMEOUT");
    const list = vi.fn(() => [timeout]);
    const built = createService({ modules: {} }, parts({ errors: list }));

    expect(list).not.toHaveBeenCalled();
    expect(built.errors.classFor("TIMEOUT")).toBe(timeout);
    expect(built.errors.classFor("TIMEOUT")).toBe(timeout);
    built.describe();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("refuses a code that two classes carry", () => {
    const built = createService(
      {
        modules: {},
        extensions: [{ name: "mine", errors: [errorClass("TIMEOUT")] }],
      },
      parts({ errors: [errorClass("TIMEOUT")] }),
    );
    const message =
      'Error code "TIMEOUT" is registered by "core" and by "mine"';

    expect(() => built.errors.classFor("TIMEOUT")).toThrow(message);
    expect(() => built.errors.classFor("SOMETHING_ELSE")).toThrow(message);
    expect(() => built.describe()).toThrow(message);
  });
});

describe("describe", () => {
  it("lists the extensions in order, the owner of each handler, error code, engine, feature and role", () => {
    const enabled = vi.fn(() => true);
    const noop = () => {};
    const built = createService(
      {
        modules: {},
        extensions: [
          {
            name: "second",
            hooks: {
              "scrape.document.derived": [noop, noop],
              "map.finished": noop,
              "process.stop": [noop, noop],
            },
            errors: [errorClass("ZEBRA", "ALPHA")],
            engines: [
              engine("zebra", { enabled }),
              engine("fetch", { quality: 99, enabled }),
            ],
            engineFeatures: featureMap({
              zebraFlag: { priority: 50 },
              waitFor: { priority: 25 },
            }),
            searchProviders: [
              searchProvider("zebra", { priority: 80, enabled }),
              searchProvider("searxng", { priority: 200, enabled }),
            ],
            llmProviders: [
              llmProvider("zebra", { enabled }),
              llmProvider("openai", { enabled }),
            ],
            workers: { zebra: worker(), api: worker() },
          },
          {
            name: "third",
            hooks: {
              "scrape.document.derived": noop,
              "process.stop": noop,
            },
          },
        ],
      },
      parts({
        hooks: {
          "scrape.document.derived": noop,
          "process.stop": noop,
        },
        errors: () => [errorClass("TIMEOUT")],
        engines: [engine("fetch", { enabled }), engine("alpha", { enabled })],
        engineFeatures: featureMap({
          waitFor: { priority: 1 },
          alphaFlag: { priority: 10 },
        }),
        searchProviders: [
          searchProvider("searxng", { priority: 50, enabled }),
          searchProvider("alpha", { priority: 10, enabled }),
        ],
        llmProviders: [
          llmProvider("openai", { enabled }),
          llmProvider("alpha", { enabled }),
        ],
        workers: { api: worker(), "queue-worker": worker() },
      }),
    );

    const description = built.describe();

    expect(enabled).not.toHaveBeenCalled();
    expect(description).toEqual({
      extensions: ["core", "second", "third"],
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
      hooks: {
        "map.finished": ["second"],
        "process.stop": ["third", "second", "second", "core"],
        "scrape.document.derived": ["core", "second", "second", "third"],
      },
      errors: { ALPHA: "second", TIMEOUT: "core", ZEBRA: "second" },
      engines: { alpha: "core", fetch: "second", zebra: "second" },
      engineFeatures: {
        alphaFlag: { owner: "core", priority: 10 },
        waitFor: { owner: "second", priority: 25 },
        zebraFlag: { owner: "second", priority: 50 },
      },
      searchProviders: {
        alpha: { owner: "core", priority: 10 },
        searxng: { owner: "second", priority: 200 },
        zebra: { owner: "second", priority: 80 },
      },
      llmProviders: { alpha: "core", openai: "second", zebra: "second" },
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
      roles: { api: "second", "queue-worker": "core", zebra: "second" },
      env: {},
    });
    expect(Object.keys(description.hooks)).toEqual([
      "map.finished",
      "process.stop",
      "scrape.document.derived",
    ]);
    expect(Object.keys(description.errors)).toEqual([
      "ALPHA",
      "TIMEOUT",
      "ZEBRA",
    ]);
    expect(Object.keys(description.engines)).toEqual([
      "alpha",
      "fetch",
      "zebra",
    ]);
    expect(Object.keys(description.engineFeatures)).toEqual([
      "alphaFlag",
      "waitFor",
      "zebraFlag",
    ]);
    expect(Object.keys(description.searchProviders)).toEqual([
      "alpha",
      "searxng",
      "zebra",
    ]);
    expect(Object.keys(description.llmProviders)).toEqual([
      "alpha",
      "openai",
      "zebra",
    ]);
    expect(Object.keys(description.roles)).toEqual([
      "api",
      "queue-worker",
      "zebra",
    ]);
  });

  it("leaves out a hook point whose list of handlers is empty", () => {
    const built = createService(
      { modules: {} },
      parts({ hooks: { "map.finished": [] } }),
    );

    expect(built.describe().hooks).toEqual({});
  });

  it("keeps describing the service as it was created", () => {
    const mineError = errorClass("MINE");
    const mineErrors = [mineError];
    const mineEngine = engine("mine-engine", { features: { waitFor: true } });
    const mineEngines = [mineEngine];
    const mineFeatures = featureMap({ mineFlag: { priority: 40 } });
    const mineSearchProvider = searchProvider("mine-search", { priority: 60 });
    const mineSearchProviders = [mineSearchProvider];
    const mineProvider = llmProvider("mine-provider");
    const mineProviders = [mineProvider];
    const initialHook = vi.fn();
    const addedHook = vi.fn();
    const mineHookList = [initialHook];
    const mineHooks: HookHandlers = { "map.finished": mineHookList };
    const mine: Extension = {
      name: "mine",
      hooks: mineHooks,
      errors: mineErrors,
      engines: mineEngines,
      engineFeatures: mineFeatures,
      searchProviders: mineSearchProviders,
      llmProviders: mineProviders,
      workers: { api: worker() },
    };
    const built = createService({ modules: {}, extensions: [mine] }, parts());

    mine.name = "renamed";
    mineHookList.push(addedHook);
    mineHooks["scrape.start"] = () => {};
    mine.hooks = { "search.finished": () => {} };
    mineErrors.push(errorClass("ADDED"));
    mine.errors = [errorClass("OTHER")];
    mineEngines.push(engine("added-engine"));
    mine.engines = [engine("other-engine")];
    mine.engineFeatures = featureMap({ otherFlag: { priority: 99 } });
    mineSearchProviders.push(searchProvider("added-search"));
    mine.searchProviders = [searchProvider("other-search")];
    mineProviders.push(llmProvider("added-provider"));
    mine.llmProviders = [llmProvider("other-provider")];
    mine.workers = { other: worker() };

    built.hooks.observe("map.finished", {
      id: "m1",
      ctx: { teamId: "t1", zeroDataRetention: false },
      urls: 1,
    });
    expect(initialHook).toHaveBeenCalledTimes(1);
    expect(addedHook).not.toHaveBeenCalled();
    expect(built.hooks.has("scrape.start")).toBe(false);
    expect(built.hooks.has("search.finished")).toBe(false);
    expect(built.errors.classFor("MINE")).toBe(mineError);
    expect(built.errors.classFor("ADDED")).toBeUndefined();
    expect(built.errors.classFor("OTHER")).toBeUndefined();
    expect(built.engines.all().map(e => e.name)).toEqual(["mine-engine"]);
    expect(built.engines.feature("mineFlag")).toEqual({ priority: 40 });
    expect(built.engines.feature("otherFlag")).toBeUndefined();
    expect(built.searchProviders.all().map(p => p.name)).toEqual([
      "mine-search",
    ]);
    expect(built.llmProviders.all().map(p => p.name)).toEqual([
      "mine-provider",
    ]);
    expect(built.describe()).toEqual({
      extensions: ["core", "mine"],
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
      hooks: { "map.finished": ["mine"] },
      errors: { MINE: "mine" },
      engines: { "mine-engine": "mine" },
      engineFeatures: { mineFlag: { owner: "mine", priority: 40 } },
      searchProviders: { "mine-search": { owner: "mine", priority: 60 } },
      llmProviders: { "mine-provider": "mine" },
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
      roles: { api: "mine" },
      env: {},
    });
  });

  it("treats a name that every object inherits as a name like any other", () => {
    const inherited = worker();
    const built = createService(
      { modules: {} },
      parts({
        engines: [engine("__proto__"), engine("constructor")],
        engineFeatures: featureMap({
          ["__proto__"]: { priority: 5 },
          constructor: { priority: 15 },
        }),
        searchProviders: [
          searchProvider("__proto__", { priority: 5 }),
          searchProvider("constructor", { priority: 15 }),
        ],
        llmProviders: [llmProvider("__proto__"), llmProvider("constructor")],
        workers: { ["__proto__"]: inherited, constructor: worker() },
      }),
    );

    const description = built.describe();

    expect(Object.hasOwn(built.workers, "__proto__")).toBe(true);
    expect(built.workers["__proto__"]).toBe(inherited);
    expect(built.engines.get("__proto__")?.name).toBe("__proto__");
    expect(built.engines.get("constructor")?.name).toBe("constructor");
    expect(built.engines.feature("__proto__")).toEqual({ priority: 5 });
    expect(built.engines.feature("constructor")).toEqual({ priority: 15 });
    expect(built.searchProviders.get("__proto__")?.name).toBe("__proto__");
    expect(built.searchProviders.get("constructor")?.name).toBe("constructor");
    expect(built.llmProviders.get("__proto__")?.name).toBe("__proto__");
    expect(built.llmProviders.get("constructor")?.name).toBe("constructor");
    expect(Object.entries(description.engines)).toEqual([
      ["__proto__", "core"],
      ["constructor", "core"],
    ]);
    expect(Object.entries(description.engineFeatures)).toEqual([
      ["__proto__", { owner: "core", priority: 5 }],
      ["constructor", { owner: "core", priority: 15 }],
    ]);
    expect(Object.entries(description.searchProviders)).toEqual([
      ["__proto__", { owner: "core", priority: 5 }],
      ["constructor", { owner: "core", priority: 15 }],
    ]);
    expect(Object.entries(description.llmProviders)).toEqual([
      ["__proto__", "core"],
      ["constructor", "core"],
    ]);
    expect(Object.entries(description.roles)).toEqual([
      ["__proto__", "core"],
      ["constructor", "core"],
    ]);
  });

  it("returns a copy, so a caller cannot change what the next one reads", () => {
    const built = createService(
      { modules: {} },
      parts({
        hooks: { "map.finished": () => {} },
        errors: [errorClass("TIMEOUT")],
        engines: [engine("fetch")],
        engineFeatures: featureMap({ waitFor: { priority: 1 } }),
        searchProviders: [searchProvider("searxng", { priority: 50 })],
        llmProviders: [llmProvider("openai")],
        workers: { api: worker() },
      }),
    );

    const first = built.describe();
    first.extensions.push("added");
    first.modules.push("added");
    first.hooks["map.finished"].push("changed");
    first.errors.TIMEOUT = "changed";
    first.engines.fetch = "changed";
    first.engineFeatures.waitFor.priority = 999;
    first.searchProviders.searxng.priority = 999;
    first.llmProviders.openai = "changed";
    first.request.scrapeOptions.injected = "changed";
    first.request.formats.injected = "changed";
    first.request.rules.push("changed");
    first.roles.api = "changed";

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
      hooks: { "map.finished": ["core"] },
      errors: { TIMEOUT: "core" },
      engines: { fetch: "core" },
      engineFeatures: { waitFor: { owner: "core", priority: 1 } },
      searchProviders: { searxng: { owner: "core", priority: 50 } },
      llmProviders: { openai: "core" },
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
      roles: { api: "core" },
      env: {},
    });
  });
});

describe("service", () => {
  it("throws while no service is installed", () => {
    expect(() => service.modules).toThrow("No service is installed");
    expect(() => service.hooks).toThrow("No service is installed");
    expect(() => service.errors).toThrow("No service is installed");
    expect(() => service.engines).toThrow("No service is installed");
    expect(() => service.searchProviders).toThrow("No service is installed");
    expect(() => service.llmProviders).toThrow("No service is installed");
    expect(() => service.schemas).toThrow("No service is installed");
    expect(() => service.roles).toThrow("No service is installed");
    expect(() => service.workers).toThrow("No service is installed");
    expect(() =>
      service.mountRoutes({
        root: {} as never,
        v2: {} as never,
        admin: {} as never,
      }),
    ).toThrow("No service is installed");
    expect(() => service.describe()).toThrow("No service is installed");
  });

  it("reads the installed service", () => {
    const mountSpy = vi.fn();
    const built = createService(
      { modules: {} },
      parts({ workers: { api: worker() }, routes: mountSpy }),
    );
    replaceService(built);

    expect(service.modules).toBe(built.modules);
    expect(service.hooks).toBe(built.hooks);
    expect(service.errors).toBe(built.errors);
    expect(service.engines).toBe(built.engines);
    expect(service.searchProviders).toBe(built.searchProviders);
    expect(service.llmProviders).toBe(built.llmProviders);
    expect(service.schemas).toBe(built.schemas);
    expect(service.roles).toBe(built.roles);
    expect(service.workers).toBe(built.workers);
    const routers = {
      root: {} as never,
      v2: {} as never,
      admin: {} as never,
    };
    service.mountRoutes(routers);
    expect(mountSpy).toHaveBeenCalledWith(routers);
    expect(service.describe()).toEqual(built.describe());
  });
});

describe("routes and roles integration", () => {
  it("mounts extension routes before core routes through built.mountRoutes and reports them in describe().routes", async () => {
    const calls: string[] = [];
    const built = createService(
      {
        modules: {},
        extensions: [
          {
            name: "ext",
            routes: ({ rootRaw, v2 }) => {
              calls.push("ext");
              rootRaw?.post("/raw-ping", function extRawPing(_req, res) {
                res.json({ ok: "raw" });
              });
              v2.get("/shared", function extShared(_req, res) {
                res.json({ from: "ext" });
              });
              v2.get("/ext-ping", function extPing(_req, res) {
                res.json({ ok: "ext" });
              });
            },
            workers: { "ext-worker": worker() },
          },
        ],
      },
      parts({
        routes: ({ v2 }) => {
          calls.push("core");
          v2.get("/shared", function coreShared(_req, res) {
            res.json({ from: "core" });
          });
          v2.get("/core-ping", function corePing(_req, res) {
            res.json({ ok: "core" });
          });
        },
        workers: { api: worker() },
      }),
    );

    expect(calls).toEqual([]);
    expect(built.roles.names()).toEqual(["api", "ext-worker"]);
    expect(built.roles.owner("api")).toBe("core");
    expect(built.roles.owner("ext-worker")).toBe("ext");

    const app = express();
    const rootRaw = express.Router();
    const v2 = express.Router();
    const admin = express.Router();
    app.use(rootRaw);
    built.mountRoutes({ rootRaw, root: app, v2, admin });
    app.use("/v2", v2);
    app.use(admin);

    expect(calls).toEqual(["ext", "core"]);

    const rawPing = await request(app).post("/raw-ping");
    expect(rawPing.status).toBe(200);
    expect(rawPing.body).toEqual({ ok: "raw" });

    const shared = await request(app).get("/v2/shared");
    expect(shared.status).toBe(200);
    expect(shared.body).toEqual({ from: "ext" });

    const extPing = await request(app).get("/v2/ext-ping");
    expect(extPing.status).toBe(200);
    expect(extPing.body).toEqual({ ok: "ext" });

    const corePing = await request(app).get("/v2/core-ping");
    expect(corePing.status).toBe(200);
    expect(corePing.body).toEqual({ ok: "core" });

    expect(built.describe().routes).toEqual([
      {
        owner: "ext",
        router: "rootRaw",
        method: "POST",
        path: "/raw-ping",
        middleware: ["extRawPing"],
      },
      {
        owner: "ext",
        router: "v2",
        method: "GET",
        path: "/v2/shared",
        middleware: ["extShared"],
      },
      {
        owner: "ext",
        router: "v2",
        method: "GET",
        path: "/v2/ext-ping",
        middleware: ["extPing"],
      },
      {
        owner: "core",
        router: "v2",
        method: "GET",
        path: "/v2/shared",
        middleware: ["coreShared"],
      },
      {
        owner: "core",
        router: "v2",
        method: "GET",
        path: "/v2/core-ping",
        middleware: ["corePing"],
      },
    ]);
    // describe() reuses metadata captured during mountRoutes instead of calling registrars again.
    expect(calls).toEqual(["ext", "core"]);
  });

  it("runs a worker role contributed by an extension and forwards an optional abort signal", async () => {
    const controller = new AbortController();
    let aborted = false;
    const customRun = vi.fn(
      ({ entry, signal }: { entry: string; signal?: AbortSignal }) => {
        expect(entry).toBe("/app/main.js");
        expect(signal).toBe(controller.signal);
        return new Promise<void>(resolve => {
          signal?.addEventListener("abort", () => {
            aborted = true;
            resolve();
          });
        });
      },
    );
    const built = createService(
      {
        modules: {},
        extensions: [
          {
            name: "custom",
            workers: { "custom-worker": { run: customRun } },
          },
        ],
      },
      parts({ workers: { api: worker() } }),
    );

    const running = run(built, "custom-worker", "/app/main.js", {
      signal: controller.signal,
    });
    expect(processRole()).toBe("custom-worker");
    expect(aborted).toBe(false);

    controller.abort();
    await running;

    expect(aborted).toBe(true);
    expect(customRun).toHaveBeenCalledWith({
      entry: "/app/main.js",
      signal: controller.signal,
    });
  });
});

describe("run", () => {
  it("installs the service, then runs the role with the entry", async () => {
    const api: Worker = {
      run: vi.fn(() => {
        expect(service.workers.api).toBe(api);
        expect(processRole()).toBe("api");
      }),
    };
    const built = createService({ modules: {} }, parts({ workers: { api } }));

    await run(built, "api", "/app/main.js");

    expect(api.run).toHaveBeenCalledWith({ entry: "/app/main.js" });
  });

  it("refuses a role the service does not have and installs nothing", () => {
    const built = createService(
      { modules: {} },
      parts({ workers: { "queue-worker": worker(), api: worker() } }),
    );

    expect(() => run(built, "toString", "/app/main.js")).toThrow(
      'Unknown role "toString". Known roles: api, queue-worker',
    );
    expect(() => service.workers).toThrow("No service is installed");
  });

  it("refuses to install a second service", async () => {
    const built = createService(
      { modules: {} },
      parts({ workers: { api: worker() } }),
    );
    await run(built, "api", "/app/main.js");

    expect(() => run(built, "api", "/app/main.js")).toThrow(
      "A service is already installed in this process",
    );
  });

  it("forgets the started role when the service is replaced", async () => {
    const built = createService(
      { modules: {} },
      parts({ workers: { api: worker() } }),
    );
    await run(built, "api", "/app/main.js");
    expect(processRole()).toBe("api");

    replaceService(undefined);

    expect(processRole()).toBeUndefined();
  });

  it("throws when the role throws before its start returns", () => {
    const built = createService(
      { modules: {} },
      parts({
        workers: {
          api: {
            run: () => {
              throw new Error("cannot load");
            },
          },
        },
      }),
    );

    expect(() => run(built, "api", "/app/main.js")).toThrow("cannot load");
  });

  it("settles as the role's start does", async () => {
    const built = createService(
      { modules: {} },
      parts({
        workers: { api: { run: () => Promise.reject(new Error("stopped")) } },
      }),
    );

    await expect(run(built, "api", "/app/main.js")).rejects.toThrow("stopped");
  });

  it("awaits process.start hooks in order before running the role", async () => {
    const events: string[] = [];
    const api: Worker = {
      run: vi.fn(() => {
        events.push("worker:run");
      }),
    };
    const built = createService(
      {
        modules: {},
        extensions: [
          {
            name: "first",
            hooks: {
              "process.start": async ({ role }) => {
                expect(processRole()).toBe("api");
                expect(service.workers.api).toBe(api);
                await Promise.resolve();
                events.push(`start:first:${role}`);
              },
            },
          },
          {
            name: "second",
            hooks: {
              "process.start": ({ role }) => {
                events.push(`start:second:${role}`);
              },
            },
          },
        ],
      },
      parts({ workers: { api } }),
    );

    await run(built, "api", "/app/main.js");

    expect(events).toEqual([
      "start:first:api",
      "start:second:api",
      "worker:run",
    ]);
    expect(api.run).toHaveBeenCalledWith({ entry: "/app/main.js" });
  });

  it("does not start the role when a process.start hook rejects", async () => {
    const api: Worker = { run: vi.fn() };
    const built = createService(
      {
        modules: {},
        extensions: [
          {
            name: "veto",
            hooks: {
              "process.start": async () => {
                throw new Error("startup blocked");
              },
            },
          },
        ],
      },
      parts({ workers: { api } }),
    );

    await expect(run(built, "api", "/app/main.js")).rejects.toThrow(
      "startup blocked",
    );
    expect(api.run).not.toHaveBeenCalled();
  });

  it("rejects when a role throws synchronously after a process.start hook runs", async () => {
    const started: string[] = [];
    const built = createService(
      {
        modules: {},
        extensions: [
          {
            name: "boot",
            hooks: {
              "process.start": ({ role }) => {
                started.push(role);
              },
            },
          },
        ],
      },
      parts({
        workers: {
          api: {
            run() {
              throw new Error("role load failed");
            },
          },
        },
      }),
    );

    await expect(run(built, "api", "/app/main.js")).rejects.toThrow(
      "role load failed",
    );
    expect(started).toEqual(["api"]);
  });
});

describe("runProcessStop", () => {
  it("is a no-op when no service is installed or no handler is registered", async () => {
    await expect(runProcessStop("api")).resolves.toBeUndefined();

    const built = createService(
      { modules: {} },
      parts({ workers: { api: worker() } }),
    );
    await run(built, "api", "/app/main.js");

    await expect(runProcessStop("api")).resolves.toBeUndefined();
  });

  it("runs process.stop hooks once in reverse order with the active role", async () => {
    const events: string[] = [];
    const built = createService(
      {
        modules: {},
        extensions: [
          {
            name: "first",
            hooks: {
              "process.stop": async ({ role }) => {
                await Promise.resolve();
                events.push(`stop:first:${role}`);
              },
            },
          },
          {
            name: "second",
            hooks: {
              "process.stop": async ({ role }) => {
                await Promise.resolve();
                events.push(`stop:second:${role}`);
              },
            },
          },
        ],
      },
      parts({ workers: { "queue-worker": worker() } }),
    );

    await run(built, "queue-worker", "/app/main.js");

    await Promise.all([runProcessStop("fallback"), runProcessStop("fallback")]);
    await runProcessStop("fallback");

    expect(events).toEqual([
      "stop:second:queue-worker",
      "stop:first:queue-worker",
    ]);
  });

  it("isolates errors and 45s timeouts across process.stop handlers", async () => {
    vi.useFakeTimers();
    try {
      const errorLogger = vi.fn();
      const events: string[] = [];
      const built = createService(
        {
          modules: {},
          extensions: [
            {
              name: "first",
              hooks: {
                "process.stop": ({ role }) => {
                  events.push(`first:${role}`);
                },
              },
            },
            {
              name: "slow",
              hooks: {
                "process.stop": () => new Promise<void>(() => {}),
              },
            },
            {
              name: "throwing",
              hooks: {
                "process.stop": () => {
                  events.push("throwing");
                  throw new Error("flush failed");
                },
              },
            },
          ],
        },
        {
          core: { name: "core", workers: { api: worker() } },
          logger: { error: errorLogger },
        },
      );
      replaceService(built);

      const pending = runProcessStop("api");
      await vi.advanceTimersByTimeAsync(45_000);
      await pending;

      expect(events).toEqual(["throwing", "first:api"]);
      expect(errorLogger).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
