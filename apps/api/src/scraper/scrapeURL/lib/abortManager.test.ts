import { AbortManager, AbortManagerThrownError } from "./abortManager";

describe("AbortManager", () => {
  test("maps an already-aborted external ownership signal immediately", () => {
    const controller = new AbortController();
    const ownershipLost = new Error("ownership lost");
    controller.abort(ownershipLost);
    const manager = new AbortManager({
      signal: controller.signal,
      tier: "external",
      throwable: () => ownershipLost,
    });

    const signal = manager.asSignal();
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(AbortManagerThrownError);
    expect(signal.reason).toMatchObject({
      tier: "external",
      inner: ownershipLost,
    });
    manager.dispose();
  });
});
