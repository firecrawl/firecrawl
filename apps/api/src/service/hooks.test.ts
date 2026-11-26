import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "winston";
import { scrapeOptions } from "../controllers/v2/types";
import type { Document } from "../controllers/v2/types";
import {
  buildHookRegistry,
  buildHooks,
  hookPointNames,
  hookPoints,
} from "./hooks";
import type {
  EnginePlan,
  HookHandler,
  HookHandlers,
  ScrapeMeta,
} from "./hooks";
import type { RequestContext } from "./request-context";

const noop = () => {};

const tick = () =>
  new Promise<void>(resolve => {
    setTimeout(resolve, 0);
  });

const ctx: RequestContext = {
  teamId: "team-1",
  zeroDataRetention: false,
};

const testLogger = createLogger({ silent: true });

const makeScrapeMeta = (): ScrapeMeta => ({
  id: "scrape-1",
  url: "https://example.com",
  ctx,
  options: scrapeOptions.parse({}),
  state: {},
  logger: testLogger,
  abort: new AbortController().signal,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("hookPoints", () => {
  it("defines all 26 hook points with frozen null-prototype metadata", () => {
    expect(hookPointNames).toHaveLength(26);
    expect(Object.isFrozen(hookPointNames)).toBe(true);
    expect(Object.isFrozen(hookPoints)).toBe(true);
    expect(Object.getPrototypeOf(hookPoints)).toBeNull();
    expect(Object.keys(hookPoints)).toEqual(hookPointNames);

    const byKind = { observe: 0, await: 0, transform: 0 };
    for (const name of hookPointNames) {
      const spec = hookPoints[name];
      expect(Object.isFrozen(spec)).toBe(true);
      byKind[spec.kind]++;
    }
    expect(byKind).toEqual({ observe: 5, await: 5, transform: 16 });

    expect(hookPoints["process.stop"]).toEqual({
      kind: "await",
      timeoutMs: 45_000,
      isolate: true,
      reverse: true,
    });
    expect(hookPoints["process.start"]).toEqual({ kind: "await" });
    expect(hookPoints["constructor"]).toBeUndefined();
    expect(hookPoints["toString"]).toBeUndefined();
    expect(hookPoints["__proto__"]).toBeUndefined();
  });
});

describe("buildHooks", () => {
  it("returns a frozen dispatcher", () => {
    expect(Object.isFrozen(buildHooks([], vi.fn()))).toBe(true);
  });

  it("reports handler presence with has() and ignores prototype keys", () => {
    const hooks = buildHooks(
      [
        {
          "map.finished": vi.fn(() => {}),
          "crawl.links": [],
          "scrape.start": undefined,
        },
      ],
      vi.fn(),
    );

    expect(hooks.has("map.finished")).toBe(true);
    expect(hooks.has("crawl.links")).toBe(false);
    expect(hooks.has("scrape.start")).toBe(false);
    expect(hooks.has("process.stop")).toBe(false);
    // @ts-expect-error: verifying has() returns false for prototype key
    expect(hooks.has("__proto__")).toBe(false);
    // @ts-expect-error: verifying has() returns false for prototype key
    expect(hooks.has("constructor")).toBe(false);
    // @ts-expect-error: verifying has() returns false for prototype key
    expect(hooks.has("toString")).toBe(false);
  });

  it("accepts null-prototype hook maps", () => {
    const handler = vi.fn(() => {});
    const map: HookHandlers = Object.create(null);
    map["map.finished"] = handler;

    const hooks = buildHooks([map], vi.fn());

    expect(hooks.has("map.finished")).toBe(true);
    hooks.observe("map.finished", { id: "m1", ctx, urls: 4 });
    expect(handler).toHaveBeenCalledWith({ id: "m1", ctx, urls: 4 });
  });

  it("snapshots sets and handler arrays so later mutations have no effect", async () => {
    const first = vi.fn(() => undefined);
    const second = vi.fn((plan: EnginePlan) => ({
      candidates: [...plan.candidates, "playwright" as const],
    }));
    const list: Array<HookHandler<"scrape.engines.select">> = [first];
    const set: HookHandlers = { "scrape.engines.select": list };
    const sets = [set];

    const hooks = buildHooks(sets, vi.fn());

    list.push(second);
    set["scrape.engines.select"] = [second];
    set["map.finished"] = vi.fn(() => {});
    sets.push({ "process.start": vi.fn(() => {}) });

    const plan: EnginePlan = { candidates: ["fetch"] };
    const result = await hooks.transform(
      "scrape.engines.select",
      plan,
      makeScrapeMeta(),
    );

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(result).toBe(plan);
    expect(hooks.has("map.finished")).toBe(false);
    expect(hooks.has("process.start")).toBe(false);
  });

  describe("validation", () => {
    it("rejects unknown hook point names, including prototype keys", () => {
      expect(() =>
        buildHooks(
          [
            // @ts-expect-error: verifying runtime rejection of unknown hook point name
            { "unknown.hook": vi.fn() },
          ],
          vi.fn(),
        ),
      ).toThrow('Unknown hook point "unknown.hook"');

      expect(() =>
        buildHooks(
          [
            // @ts-expect-error: verifying runtime rejection of unknown hook point name with undefined value
            { "unknown.hook": undefined },
          ],
          vi.fn(),
        ),
      ).toThrow('Unknown hook point "unknown.hook"');

      expect(() =>
        buildHooks(
          [
            // @ts-expect-error: verifying runtime rejection of prototype key constructor
            { constructor: vi.fn() },
          ],
          vi.fn(),
        ),
      ).toThrow('Unknown hook point "constructor"');

      expect(() =>
        buildHooks(
          [
            // @ts-expect-error: verifying runtime rejection of prototype key toString
            { toString: vi.fn() },
          ],
          vi.fn(),
        ),
      ).toThrow('Unknown hook point "toString"');

      const withProtoKey = Object.defineProperty({}, "__proto__", {
        value: vi.fn(),
        enumerable: true,
      });
      expect(() => buildHooks([withProtoKey], vi.fn())).toThrow(
        'Unknown hook point "__proto__"',
      );
    });

    it("rejects non-function handlers and invalid hook containers", () => {
      expect(() =>
        buildHooks(
          [
            // @ts-expect-error: verifying runtime rejection of null handler
            { "map.finished": null },
          ],
          vi.fn(),
        ),
      ).toThrow('Hook "map.finished" handler must be a function');

      expect(() =>
        buildHooks(
          [
            // @ts-expect-error: verifying runtime rejection of string handler
            { "map.finished": "nope" },
          ],
          vi.fn(),
        ),
      ).toThrow('Hook "map.finished" handler must be a function');

      expect(() =>
        buildHooks(
          [
            // @ts-expect-error: verifying runtime rejection of non-function array element
            { "map.finished": [vi.fn(), 42] },
          ],
          vi.fn(),
        ),
      ).toThrow('Hook "map.finished" handler at index 1 must be a function');

      expect(() =>
        buildHooks(
          [
            // @ts-expect-error: verifying runtime rejection of undefined array element
            { "map.finished": [vi.fn(), undefined] },
          ],
          vi.fn(),
        ),
      ).toThrow('Hook "map.finished" handler at index 1 must be a function');

      const sparse = new Array(1);
      expect(() => buildHooks([{ "map.finished": sparse }], vi.fn())).toThrow(
        'Hook "map.finished" handler at index 0 must be a function',
      );

      expect(() =>
        buildHooks(
          [
            // @ts-expect-error: verifying runtime rejection of null hook container
            null,
          ],
          vi.fn(),
        ),
      ).toThrow('Extension "set-0" hooks must be a plain object');

      expect(() =>
        buildHooks(
          [
            // @ts-expect-error: verifying runtime rejection of array hook container
            [],
          ],
          vi.fn(),
        ),
      ).toThrow('Extension "set-0" hooks must be a plain object');

      expect(() =>
        buildHooks(
          [
            // @ts-expect-error: verifying runtime rejection of Map hook container
            new Map(),
          ],
          vi.fn(),
        ),
      ).toThrow('Extension "set-0" hooks must be a plain object');

      expect(() =>
        buildHooks(
          [],
          // @ts-expect-error: verifying runtime rejection of null error reporter
          null,
        ),
      ).toThrow("Hook error reporter must be a function");
    });
  });

  describe("observe", () => {
    it("runs handlers in registration order without waiting and is a no-op when empty", () => {
      const order: Array<string> = [];
      let asyncFinished = false;
      const hooks = buildHooks(
        [
          {
            "map.finished": () => {
              order.push("first");
            },
          },
          {
            "map.finished": [
              async () => {
                order.push("second-start");
                await tick();
                asyncFinished = true;
              },
              () => {
                order.push("third");
              },
            ],
          },
        ],
        vi.fn(),
      );

      hooks.observe("map.finished", { id: "m1", ctx, urls: 2 });
      hooks.observe("concurrency.limited", { ctx, limit: 5 });

      expect(order).toEqual(["first", "second-start", "third"]);
      expect(asyncFinished).toBe(false);
    });

    it("isolates sync throws and async rejections, reports them, and runs remaining handlers", async () => {
      const report = vi.fn();
      const last = vi.fn();
      const syncErr = new Error("sync failure");
      const asyncErr = new Error("async failure");
      const thenableErr = new Error("thenable failure");
      const hooks = buildHooks(
        [
          {
            "job.enqueued": [
              () => {
                throw syncErr;
              },
              () => Promise.reject(asyncErr),
              () => ({
                // @ts-expect-error: verifying observe() catches rejection from a plain thenable
                then(_resolve: unknown, reject: (err: unknown) => void) {
                  reject(thenableErr);
                },
              }),
              last,
            ],
          },
        ],
        report,
      );

      const payload = { jobId: "j1", kind: "scrape" as const, ctx };
      expect(() => hooks.observe("job.enqueued", payload)).not.toThrow();
      await tick();

      expect(last).toHaveBeenCalledWith(payload);
      expect(report.mock.calls).toEqual([
        ["job.enqueued", syncErr],
        ["job.enqueued", asyncErr],
        ["job.enqueued", thenableErr],
      ]);
    });

    it("keeps a throwing reporter away from the caller and unhandledRejection", async () => {
      const unhandled = vi.fn();
      const last = vi.fn();
      const hooks = buildHooks(
        [
          {
            "search.finished": [
              () => {
                throw new Error("sync");
              },
              () => Promise.reject(new Error("async")),
              last,
            ],
          },
        ],
        () => {
          throw new Error("reporter failed");
        },
      );

      process.on("unhandledRejection", unhandled);
      try {
        expect(() =>
          hooks.observe("search.finished", {
            id: "s1",
            ctx,
            results: 1,
            charged: undefined,
          }),
        ).not.toThrow();
        await tick();
      } finally {
        process.off("unhandledRejection", unhandled);
      }

      expect(last).toHaveBeenCalledTimes(1);
      expect(unhandled).not.toHaveBeenCalled();
    });
  });

  describe("run", () => {
    it("runs handlers sequentially in registration order across sets", async () => {
      const order: Array<string> = [];
      const hooks = buildHooks(
        [
          {
            "process.start": async ({ role }) => {
              order.push(`first-start:${role}`);
              await tick();
              order.push("first-end");
            },
          },
          {
            "process.start": [
              () => {
                order.push("second");
              },
              async () => {
                await tick();
                order.push("third");
              },
            ],
          },
        ],
        vi.fn(),
      );

      await hooks.run("process.start", { role: "api" });

      expect(order).toEqual([
        "first-start:api",
        "first-end",
        "second",
        "third",
      ]);
    });

    it("propagates errors on non-isolated await points and stops later handlers", async () => {
      const report = vi.fn();
      const later = vi.fn();
      const hooks = buildHooks(
        [
          {
            "crawl.finished": [
              () => {
                throw new Error("vetoed");
              },
              later,
            ],
          },
        ],
        report,
      );

      await expect(
        hooks.run("crawl.finished", {
          id: "c1",
          kind: "crawl",
          ctx,
          completed: 3,
          cancelled: false,
        }),
      ).rejects.toThrow("vetoed");
      expect(later).not.toHaveBeenCalled();
      expect(report).not.toHaveBeenCalled();
    });

    it("runs process.stop handlers in reverse registration order and isolates sync and async failures", async () => {
      const report = vi.fn();
      const order: Array<string> = [];
      const syncErr = new Error("sync stop failure");
      const asyncErr = new Error("async stop failure");

      const hooks = buildHooks(
        [
          {
            "process.stop": [
              () => {
                order.push("first");
              },
              async () => {
                order.push("second-async-reject");
                await tick();
                throw asyncErr;
              },
            ],
          },
          {
            "process.stop": [
              () => {
                order.push("third-sync-throw");
                throw syncErr;
              },
              async ({ role }) => {
                order.push(`fourth:${role}`);
                await tick();
              },
            ],
          },
        ],
        report,
      );

      await expect(
        hooks.run("process.stop", { role: "queue-worker" }),
      ).resolves.toBeUndefined();

      expect(order).toEqual([
        "fourth:queue-worker",
        "third-sync-throw",
        "second-async-reject",
        "first",
      ]);
      expect(report.mock.calls).toEqual([
        ["process.stop", syncErr],
        ["process.stop", asyncErr],
      ]);
    });

    it("continues remaining process.stop handlers even if the error reporter throws", async () => {
      const order: Array<string> = [];
      const hooks = buildHooks(
        [
          {
            "process.stop": [
              () => {
                order.push("cleanup-still-runs");
              },
              () => {
                order.push("failing-stop");
                throw new Error("boom");
              },
            ],
          },
        ],
        () => {
          throw new Error("logger broken");
        },
      );

      await expect(
        hooks.run("process.stop", { role: "api" }),
      ).resolves.toBeUndefined();
      expect(order).toEqual(["failing-stop", "cleanup-still-runs"]);
    });

    it("times out a hanging process.stop handler after 45_000ms, isolates it, and runs remaining handlers", async () => {
      vi.useFakeTimers();
      const report = vi.fn<(hook: string, error: unknown) => void>();
      const order: Array<string> = [];
      let rejectLate: ((reason: Error) => void) | undefined;

      const hooks = buildHooks(
        [
          {
            "process.stop": [
              () => {
                order.push("earlier-registered-runs-after-timeout");
              },
              () =>
                new Promise<void>((_resolve, reject) => {
                  order.push("hanging-started");
                  rejectLate = reject;
                }),
            ],
          },
        ],
        report,
      );

      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      try {
        const pending = hooks.run("process.stop", { role: "api" });
        await vi.advanceTimersByTimeAsync(44_999);
        expect(order).toEqual(["hanging-started"]);
        expect(report).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        await pending;

        expect(order).toEqual([
          "hanging-started",
          "earlier-registered-runs-after-timeout",
        ]);
        expect(report).toHaveBeenCalledTimes(1);
        const [reportedHook, reportedError] = report.mock.calls[0] ?? [];
        expect(reportedHook).toBe("process.stop");
        expect(reportedError).toBeInstanceOf(Error);
        if (reportedError instanceof Error) {
          expect(reportedError.message).toBe(
            'Hook "process.stop" timed out after 45000ms',
          );
        }
        expect(vi.getTimerCount()).toBe(0);

        rejectLate?.(new Error("late rejection"));
        await Promise.resolve();
        await Promise.resolve();
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off("unhandledRejection", unhandled);
      }
    });

    it("clears timeout timers when process.stop handlers settle early or run synchronously", async () => {
      vi.useFakeTimers();
      const report = vi.fn();
      let resolveFirst: (() => void) | undefined;
      let rejectSecond: ((error: Error) => void) | undefined;
      const syncHandler = vi.fn();

      const hooks = buildHooks(
        [
          {
            "process.stop": [
              syncHandler,
              () =>
                new Promise<void>((_resolve, reject) => {
                  rejectSecond = reject;
                }),
              () =>
                new Promise<void>(resolve => {
                  resolveFirst = resolve;
                }),
            ],
          },
        ],
        report,
      );

      const pending = hooks.run("process.stop", { role: "api" });
      expect(vi.getTimerCount()).toBe(1);

      resolveFirst?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);

      const failure = new Error("early reject");
      rejectSecond?.(failure);
      await pending;

      expect(syncHandler).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(report).toHaveBeenCalledWith("process.stop", failure);
    });
  });

  describe("transform", () => {
    it("returns the value synchronously without allocating a promise when no handler is registered", () => {
      const hooks = buildHooks(
        [{ "map.finished": vi.fn(() => {}), "crawl.links": [] }],
        vi.fn(),
      );
      const links = ["https://example.com/a"];

      const result = hooks.transform("crawl.links", links, {
        id: "c1",
        ctx,
        from: "https://example.com",
      });

      expect(result).toBe(links);
      expect(result instanceof Promise).toBe(false);
    });

    it("chains replacement values and keeps current value on void or undefined returns", async () => {
      const hooks = buildHooks(
        [
          {
            "crawl.links": (links, info) => [...links, `${info.from}/one`],
          },
          {
            "crawl.links": [
              links => {
                links.push("https://example.com/mutated");
                return undefined;
              },
              async () => {
                await tick();
              },
              async links => [...links, "https://example.com/last"],
            ],
          },
        ],
        vi.fn(),
      );

      const result = hooks.transform("crawl.links", ["https://example.com"], {
        id: "c1",
        ctx,
        from: "https://example.com",
      });

      expect(result instanceof Promise).toBe(true);
      await expect(result).resolves.toEqual([
        "https://example.com",
        "https://example.com/one",
        "https://example.com/mutated",
        "https://example.com/last",
      ]);
    });

    it("replaces the current value when a handler returns an empty array or object", async () => {
      const hooks = buildHooks(
        [
          {
            "map.collect": () => [],
          },
        ],
        vi.fn(),
      );

      await expect(
        hooks.transform("map.collect", ["https://example.com/a"], {
          ctx,
          url: "https://example.com",
          limit: 10,
        }),
      ).resolves.toEqual([]);
    });

    it("propagates handler errors and stops later handlers", async () => {
      const report = vi.fn();
      const later = vi.fn();
      const hooks = buildHooks(
        [
          {
            "scrape.document.final": [
              () => {
                throw new Error("transform failed");
              },
              later,
            ],
          },
        ],
        report,
      );

      const doc: Document = {
        metadata: { statusCode: 200, proxyUsed: "basic" },
      };
      await expect(
        hooks.transform("scrape.document.final", doc, makeScrapeMeta()),
      ).rejects.toThrow("transform failed");
      expect(later).not.toHaveBeenCalled();
      expect(report).not.toHaveBeenCalled();
    });
  });
});

describe("buildHookRegistry", () => {
  it("reports hook handler owners sorted by point name in execution order", () => {
    const { hooks, describedHooks } = buildHookRegistry(
      [
        {
          owner: "core",
          hooks: {
            "scrape.document.derived": noop,
            "process.stop": noop,
            "map.collect": [],
          },
        },
        {
          owner: "second",
          hooks: {
            "scrape.document.derived": [noop, noop],
            "map.finished": noop,
            "process.stop": [noop, noop],
          },
        },
        {
          owner: "third",
          hooks: {
            "scrape.document.derived": noop,
            "process.stop": noop,
          },
        },
      ],
      vi.fn(),
    );

    expect(hooks.has("map.collect")).toBe(false);
    expect(hooks.has("map.finished")).toBe(true);
    expect(describedHooks).toEqual({
      "map.finished": ["second"],
      "process.stop": ["third", "second", "second", "core"],
      "scrape.document.derived": ["core", "second", "second", "third"],
    });
    expect(Object.keys(describedHooks)).toEqual([
      "map.finished",
      "process.stop",
      "scrape.document.derived",
    ]);
  });
});
