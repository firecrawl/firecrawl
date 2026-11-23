import { afterEach, describe, expect, it, vi } from "vitest";
import type { TransportableErrorClass } from "../lib/error";
import type { HookHandlers } from "./hooks";
import {
  createService,
  processRole,
  replaceService,
  run,
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

// No hook point exists yet, so a handler can only be listed through a cast.
const handlers = (listed: Record<string, unknown>) =>
  listed as unknown as HookHandlers;

// A test's codes are not in ErrorCodes, so a class can only be built through a cast.
const errorClass = (...codes: string[]) =>
  ({ codes, deserialize: vi.fn() }) as unknown as TransportableErrorClass;

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
      hooks: handlers({
        seen: () => {
          throw failure;
        },
      }),
    });
    const hooks = createService({ modules: {} }, logged).hooks as unknown as {
      observe(name: string, payload: unknown): void;
    };

    expect(() => hooks.observe("seen", {})).not.toThrow();
    expect(logged.logger.error).toHaveBeenCalledWith("Hook handler failed", {
      hook: "seen",
      error: failure,
    });
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
  it("lists the extensions in order, the owner of each handler, error code and role", () => {
    const built = createService(
      {
        modules: {},
        extensions: [
          {
            name: "second",
            hooks: handlers({
              "b.point": [vi.fn(), vi.fn()],
              "a.point": vi.fn(),
            }),
            errors: [errorClass("ZEBRA", "ALPHA")],
            workers: { zebra: worker(), api: worker() },
          },
          { name: "third", hooks: handlers({ "b.point": vi.fn() }) },
        ],
      },
      parts({
        hooks: handlers({ "b.point": vi.fn() }),
        errors: () => [errorClass("TIMEOUT")],
        workers: { api: worker(), "queue-worker": worker() },
      }),
    );

    const description = built.describe();

    expect(description).toEqual({
      extensions: ["core", "second", "third"],
      modules: [],
      hooks: {
        "a.point": ["second"],
        "b.point": ["core", "second", "second", "third"],
      },
      errors: { ALPHA: "second", TIMEOUT: "core", ZEBRA: "second" },
      roles: { api: "second", "queue-worker": "core", zebra: "second" },
      env: {},
    });
    expect(Object.keys(description.hooks)).toEqual(["a.point", "b.point"]);
    expect(Object.keys(description.errors)).toEqual([
      "ALPHA",
      "TIMEOUT",
      "ZEBRA",
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
      parts({ hooks: handlers({ "a.point": [] }) }),
    );

    expect(built.describe().hooks).toEqual({});
  });

  it("keeps describing the service as it was created", () => {
    const mineError = errorClass("MINE");
    const mineErrors = [mineError];
    const mine: Extension = {
      name: "mine",
      hooks: handlers({ "a.point": vi.fn() }),
      errors: mineErrors,
      workers: { api: worker() },
    };
    const built = createService({ modules: {}, extensions: [mine] }, parts());

    mine.name = "renamed";
    mine.hooks = handlers({ "b.point": vi.fn() });
    mineErrors.push(errorClass("ADDED"));
    mine.errors = [errorClass("OTHER")];
    mine.workers = { other: worker() };

    expect(built.errors.classFor("MINE")).toBe(mineError);
    expect(built.errors.classFor("ADDED")).toBeUndefined();
    expect(built.errors.classFor("OTHER")).toBeUndefined();
    expect(built.describe()).toEqual({
      extensions: ["core", "mine"],
      modules: [],
      hooks: { "a.point": ["mine"] },
      errors: { MINE: "mine" },
      roles: { api: "mine" },
      env: {},
    });
  });

  it("treats a name that every object inherits as a name like any other", () => {
    const inherited = worker();
    const built = createService(
      { modules: {} },
      parts({
        hooks: handlers({ constructor: vi.fn() }),
        workers: { ["__proto__"]: inherited, constructor: worker() },
      }),
    );

    const description = built.describe();

    expect(Object.hasOwn(built.workers, "__proto__")).toBe(true);
    expect(built.workers["__proto__"]).toBe(inherited);
    expect(Object.keys(description.hooks)).toEqual(["constructor"]);
    expect(description.hooks.constructor).toEqual(["core"]);
    expect(Object.entries(description.roles)).toEqual([
      ["__proto__", "core"],
      ["constructor", "core"],
    ]);
  });

  it("returns a copy, so a caller cannot change what the next one reads", () => {
    const built = createService(
      { modules: {} },
      parts({ errors: [errorClass("TIMEOUT")], workers: { api: worker() } }),
    );

    const first = built.describe();
    first.extensions.push("added");
    first.errors.TIMEOUT = "changed";
    first.roles.api = "changed";

    expect(built.describe()).toEqual({
      extensions: ["core"],
      modules: [],
      hooks: {},
      errors: { TIMEOUT: "core" },
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
    expect(() => service.workers).toThrow("No service is installed");
    expect(() => service.describe()).toThrow("No service is installed");
  });

  it("reads the installed service", () => {
    const built = createService(
      { modules: {} },
      parts({ workers: { api: worker() } }),
    );
    replaceService(built);

    expect(service.modules).toBe(built.modules);
    expect(service.hooks).toBe(built.hooks);
    expect(service.errors).toBe(built.errors);
    expect(service.workers).toBe(built.workers);
    expect(service.describe()).toEqual(built.describe());
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
});
