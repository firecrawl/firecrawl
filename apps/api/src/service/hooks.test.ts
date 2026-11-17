import { describe, expect, it, vi } from "vitest";
import { buildHooks, type Await, type Observe, type Transform } from "./hooks";

interface Points {
  seen: Observe<{ id: string }>;
  checked: Await<{ id: string }>;
  shaped: Transform<string[], { id: string }>;
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe("buildHooks", () => {
  it("runs the handlers of a point in the order of the sets, then of each set", async () => {
    const order: string[] = [];
    const hooks = buildHooks<Points>(
      [
        { checked: () => void order.push("first") },
        {
          checked: [
            () => void order.push("second"),
            () => void order.push("third"),
          ],
        },
      ],
      vi.fn(),
    );

    await hooks.run("checked", { id: "a" });

    expect(order).toEqual(["first", "second", "third"]);
  });

  describe("observe", () => {
    it("reports a handler that throws or rejects and still runs the rest", async () => {
      const report = vi.fn();
      const last = vi.fn();
      const thrown = new Error("thrown");
      const rejected = new Error("rejected");
      const hooks = buildHooks<Points>(
        [
          {
            seen: [
              () => {
                throw thrown;
              },
              () => Promise.reject(rejected),
              last,
            ],
          },
        ],
        report,
      );

      expect(() => hooks.observe("seen", { id: "a" })).not.toThrow();
      await tick();

      expect(last).toHaveBeenCalledWith({ id: "a" });
      expect(report.mock.calls).toEqual([
        ["seen", thrown],
        ["seen", rejected],
      ]);
    });

    it("does not wait for a handler", () => {
      let finished = false;
      const hooks = buildHooks<Points>(
        [
          {
            seen: async () => {
              await tick();
              finished = true;
            },
          },
        ],
        vi.fn(),
      );

      hooks.observe("seen", { id: "a" });

      expect(finished).toBe(false);
    });
  });

  describe("run", () => {
    it("waits for each handler before it starts the next", async () => {
      const order: string[] = [];
      const hooks = buildHooks<Points>(
        [
          {
            checked: [
              async () => {
                await tick();
                order.push("first done");
              },
              () => void order.push("second started"),
            ],
          },
        ],
        vi.fn(),
      );

      await hooks.run("checked", { id: "a" });

      expect(order).toEqual(["first done", "second started"]);
    });

    it("passes a handler error to the caller and runs no later handler", async () => {
      const report = vi.fn();
      const later = vi.fn();
      const hooks = buildHooks<Points>(
        [
          {
            checked: [
              () => {
                throw new Error("refused");
              },
              later,
            ],
          },
        ],
        report,
      );

      await expect(hooks.run("checked", { id: "a" })).rejects.toThrow(
        "refused",
      );
      expect(later).not.toHaveBeenCalled();
      expect(report).not.toHaveBeenCalled();
    });
  });

  describe("transform", () => {
    it("returns the value itself, with no promise, when the point has no handler", () => {
      const hooks = buildHooks<Points>([{ seen: () => {} }], vi.fn());
      const value = ["a"];

      expect(hooks.transform("shaped", value, { id: "a" })).toBe(value);
    });

    it("treats an empty list of handlers as no handler", () => {
      const hooks = buildHooks<Points>([{ shaped: [] }], vi.fn());
      const value = ["a"];

      expect(hooks.transform("shaped", value, { id: "a" })).toBe(value);
    });

    it("hands each handler the value the one before it returned", async () => {
      const hooks = buildHooks<Points>(
        [
          { shaped: (value, info) => [...value, info.id] },
          { shaped: () => undefined },
          { shaped: async value => [...value, "last"] },
        ],
        vi.fn(),
      );

      await expect(
        hooks.transform("shaped", ["a"], { id: "b" }),
      ).resolves.toEqual(["a", "b", "last"]);
    });

    it("passes a handler error to the caller", async () => {
      const hooks = buildHooks<Points>(
        [
          {
            shaped: () => {
              throw new Error("refused");
            },
          },
        ],
        vi.fn(),
      );

      await expect(hooks.transform("shaped", [], { id: "a" })).rejects.toThrow(
        "refused",
      );
    });
  });
});
