import { describe, expect, test, vi } from "vitest";
import { Watcher } from "../../../v2/watcher";
import { HttpClient } from "../../../v2/utils/httpClient";

function watcher() {
  return new Watcher(new HttpClient({ apiKey: "test-key", apiUrl: "https://api.firecrawl.dev" }), "job");
}

describe("watcher once listeners", () => {
  test.each(["once", "prependOnceListener"] as const)("%s fires only once during a reentrant emit", (method) => {
    const subject = watcher();
    const listener = vi.fn();
    let reentered = false;
    subject[method]("snapshot", listener);
    subject.prependListener("snapshot", () => {
      if (!reentered) {
        reentered = true;
        subject.emit("snapshot", "nested");
      }
    });

    subject.emit("snapshot", "outer");

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith("nested");
  });

  test.each(["once", "prependOnceListener"] as const)("%s raw wrapper cannot fire again", (method) => {
    const subject = watcher();
    const listener = vi.fn();
    subject[method]("snapshot", listener);
    const [wrapper] = subject.rawListeners("snapshot");

    wrapper("first");
    wrapper("second");

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith("first");
    expect(subject.listenerCount("snapshot")).toBe(0);
  });

  test("regular listeners keep receiving subsequent events", () => {
    const subject = watcher();
    const listener = vi.fn();
    subject.on("snapshot", listener);

    subject.emit("snapshot", "first");
    subject.emit("snapshot", "second");

    expect(listener).toHaveBeenCalledTimes(2);
  });
});
