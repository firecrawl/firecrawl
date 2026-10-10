import { createServer } from "node:http";
import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { AbortManager, AbortManagerThrownError } from "./abortManager";

describe("AbortManager source cancellation propagation", () => {
  for (const mode of ["constructor", "add"] as const) {
    it(`pre-aborted ${mode} source prevents native HTTP delivery`, async () => {
      let delivered = 0;
      const server = createServer((_req, res) => {
        delivered++;
        res.end("unexpected delivery");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const manager = new AbortManager();
      try {
        const controller = new AbortController();
        const inner = new Error("owned cancellation");
        controller.abort(inner);
        const instance = { signal: controller.signal, tier: "external" as const, throwable: () => inner };
        const active = mode === "constructor" ? new AbortManager(instance) : manager;
        if (mode === "add") {
          active.asSignal();
          active.add(instance);
        }
        try {
          const port = (server.address() as { port: number }).port;
          await expect(fetch(`http://127.0.0.1:${port}/owned`, { signal: active.asSignal() })).rejects.toMatchObject({
            name: "AbortManagerThrownError", tier: "external", inner,
          });
          expect(delivered).toBe(0);
          expect(active.isAborted()).toBe(true);
          expect(active.asSignal().reason).toBeInstanceOf(AbortManagerThrownError);
        } finally {
          active.dispose();
        }
      } finally {
        manager.dispose();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
      }
    });
  }

  it("future abort preserves signal identity and wrapped thrown reason", () => {
    const controller = new AbortController();
    const inner = new Error("owned engine failure");
    const manager = new AbortManager({ signal: controller.signal, tier: "engine", throwable: () => { throw inner; } });
    try {
      const signal = manager.asSignal();
      expect(signal.aborted).toBe(false);
      controller.abort();
      expect(manager.asSignal()).toBe(signal);
      expect(signal.reason).toMatchObject({ tier: "engine", inner });
      expect(() => manager.throwIfAborted()).toThrow(AbortManagerThrownError);
    } finally {
      manager.dispose();
    }
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("live added sources remain active until their later abort", () => {
    const controller = new AbortController();
    const manager = new AbortManager();
    try {
      const signal = manager.asSignal();
      manager.add({ signal: controller.signal, tier: "scrape", throwable: () => "deadline" });
      expect(signal.aborted).toBe(false);
      controller.abort();
      expect(signal.reason).toMatchObject({ tier: "scrape", inner: "deadline" });
    } finally {
      manager.dispose();
    }
  });
});
