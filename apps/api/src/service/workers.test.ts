import { describe, expect, it, vi } from "vitest";
import { buildWorkerRegistry } from "./workers";
import type { Worker } from "./workers";

const worker = (): Worker => ({ run: vi.fn() });

describe("buildWorkerRegistry", () => {
  it("registers roles across extensions and lets later extensions replace earlier ones", () => {
    const coreApi = worker();
    const coreQueue = worker();
    const extApi = worker();
    const extCustom = worker();

    const { roles, workers, describedRoles } = buildWorkerRegistry([
      { owner: "core", workers: { api: coreApi, "queue-worker": coreQueue } },
      { owner: "custom", workers: { api: extApi, "custom-worker": extCustom } },
    ]);

    expect(Object.isFrozen(roles)).toBe(true);
    expect(Object.isFrozen(workers)).toBe(true);
    expect(Object.isFrozen(roles.names())).toBe(true);

    expect(roles.names()).toEqual(["api", "custom-worker", "queue-worker"]);
    expect(roles.has("api")).toBe(true);
    expect(roles.has("custom-worker")).toBe(true);
    expect(roles.has("queue-worker")).toBe(true);
    expect(roles.has("missing")).toBe(false);
    expect(roles.has("toString")).toBe(false);

    expect(roles.get("api")).toBe(extApi);
    expect(roles.get("queue-worker")).toBe(coreQueue);
    expect(roles.get("custom-worker")).toBe(extCustom);
    expect(roles.get("missing")).toBeUndefined();

    expect(roles.owner("api")).toBe("custom");
    expect(roles.owner("queue-worker")).toBe("core");
    expect(roles.owner("custom-worker")).toBe("custom");
    expect(roles.owner("missing")).toBeUndefined();

    expect(workers.api).toBe(extApi);
    expect(workers["queue-worker"]).toBe(coreQueue);
    expect(workers["custom-worker"]).toBe(extCustom);

    expect(describedRoles).toEqual({
      api: "custom",
      "custom-worker": "custom",
      "queue-worker": "core",
    });
  });

  it("handles prototype-inherited role names without prototype collisions", () => {
    const protoWorker = worker();
    const ctorWorker = worker();

    const { roles, workers, describedRoles } = buildWorkerRegistry([
      {
        owner: "core",
        workers: { ["__proto__"]: protoWorker, constructor: ctorWorker },
      },
    ]);

    expect(roles.has("__proto__")).toBe(true);
    expect(roles.has("constructor")).toBe(true);
    expect(roles.has("hasOwnProperty")).toBe(false);
    expect(roles.get("__proto__")).toBe(protoWorker);
    expect(roles.get("constructor")).toBe(ctorWorker);
    expect(roles.owner("__proto__")).toBe("core");
    expect(Object.hasOwn(workers, "__proto__")).toBe(true);
    expect(workers["__proto__"]).toBe(protoWorker);
    expect(Object.entries(describedRoles)).toEqual([
      ["__proto__", "core"],
      ["constructor", "core"],
    ]);
  });

  it("snapshots extension worker maps so later mutations have no effect", () => {
    const initial = worker();
    const map = Object.fromEntries<Worker>([["api", initial]]);

    const { roles, workers } = buildWorkerRegistry([
      { owner: "core", workers: map },
    ]);

    map.api = worker();
    map.added = worker();

    expect(roles.names()).toEqual(["api"]);
    expect(roles.get("api")).toBe(initial);
    expect(roles.has("added")).toBe(false);
    expect(workers.api).toBe(initial);
  });

  it("rejects non-plain workers objects, blank role names, and invalid workers", () => {
    expect(() =>
      buildWorkerRegistry([
        // @ts-expect-error: verifying runtime rejection of null workers map
        { owner: "bad", workers: null },
      ]),
    ).toThrow('Extension "bad" workers must be a plain object');

    expect(() =>
      buildWorkerRegistry([
        // @ts-expect-error: verifying runtime rejection of array workers map
        { owner: "bad", workers: [] },
      ]),
    ).toThrow('Extension "bad" workers must be a plain object');

    expect(() =>
      buildWorkerRegistry([{ owner: "bad", workers: { "": worker() } }]),
    ).toThrow('Extension "bad" worker role name must be a non-empty string');

    expect(() =>
      buildWorkerRegistry([{ owner: "bad", workers: { "   ": worker() } }]),
    ).toThrow('Extension "bad" worker role name must be a non-empty string');

    expect(() =>
      buildWorkerRegistry([
        {
          owner: "bad",
          // @ts-expect-error: verifying runtime rejection of null worker entry
          workers: { broken: null },
        },
      ]),
    ).toThrow(
      'Worker "broken" in extension "bad" must provide a run() function',
    );

    expect(() =>
      buildWorkerRegistry([
        {
          owner: "bad",
          // @ts-expect-error: verifying runtime rejection of non-function worker.run
          workers: { broken: { run: "nope" } },
        },
      ]),
    ).toThrow(
      'Worker "broken" in extension "bad" must provide a run() function',
    );
  });
});
