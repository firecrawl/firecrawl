import { afterEach, describe, expect, it, vi } from "vitest";
import { getEventListeners } from "node:events";

vi.mock("./logger", () => ({ logger: { error: vi.fn(), warn: vi.fn() } }));
import { executeWithRetry } from "./retry-utils";

describe("retry abort signal lifecycle", () => {
  afterEach(() => vi.restoreAllMocks());
  it("releases abort listeners after ordinary retry delays complete", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const operation = async () => { attempts++; return null; };
    const valid = (result: number | null): result is number => result !== null;
    for (let i = 0; i < 12; i++) {
      expect(await executeWithRetry(operation, valid, controller.signal, 2, [1])).toBeNull();
    }
    expect(attempts).toBe(24);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
  it("removes only its own listener and preserves caller abort observation", async () => {
    const controller = new AbortController();
    const caller = vi.fn();
    controller.signal.addEventListener("abort", caller);
    const operation = vi.fn(async () => null);
    const valid = (result: number | null): result is number => result !== null;
    await executeWithRetry(operation, valid, controller.signal, 2, [1]);
    expect(getEventListeners(controller.signal, "abort")).toEqual([caller]);
    controller.abort();
    expect(caller).toHaveBeenCalledOnce();
  });
  it("abort during backoff stops further attempts and removes the sleep listener", async () => {
    const controller = new AbortController();
    const operation = vi.fn(async () => null);
    const valid = (result: number | null): result is number => result !== null;
    const pending = executeWithRetry(operation, valid, controller.signal, 2, [1000]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    expect(await pending).toBeNull();
    expect(operation).toHaveBeenCalledOnce();
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
  it("success and already-aborted signals do not install sleep listeners", async () => {
    const controller = new AbortController();
    const operation = vi.fn(async () => 1);
    const valid = (result: number | null): result is number => result !== null;
    expect(await executeWithRetry(operation, valid, controller.signal)).toBe(1);
    controller.abort();
    expect(await executeWithRetry(operation, valid, controller.signal)).toBeNull();
    expect(operation).toHaveBeenCalledOnce();
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
});
