import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("describe", () => {
  it("lists the extensions in order, the owner of each handler and of each role", () => {
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
            workers: { zebra: worker(), api: worker() },
          },
          { name: "third", hooks: handlers({ "b.point": vi.fn() }) },
        ],
      },
      parts({
        hooks: handlers({ "b.point": vi.fn() }),
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
      roles: { api: "second", "queue-worker": "core", zebra: "second" },
    });
    expect(Object.keys(description.hooks)).toEqual(["a.point", "b.point"]);
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
});

describe("service", () => {
  it("throws while no service is installed", () => {
    expect(() => service.modules).toThrow("No service is installed");
    expect(() => service.hooks).toThrow("No service is installed");
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
