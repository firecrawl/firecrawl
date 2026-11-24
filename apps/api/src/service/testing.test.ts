import { describe, expect, it, vi } from "vitest";
import { defaultModules, logsMessages } from "./defaults";
import { service, type CoreParts } from "./service";
import { testService, withService } from "./testing";

const parts: CoreParts = { core: { name: "core" }, logger: { error: vi.fn() } };

describe("testService", () => {
  it("replaces a module and adds extensions", () => {
    const base = defaultModules();
    const customMessages = {
      ...logsMessages(),
      errorContact: () => "Custom contact.",
    };
    const built = testService(base, parts, { messages: customMessages }, [
      { name: "extra" },
    ]);

    expect(built.modules.messages).toBe(customMessages);
    expect(built.modules.uploads).toBe(base.uploads);
    expect(built.describe().modules).toEqual(["messages", "uploads"]);
    expect(built.describe().extensions).toEqual(["core", "extra"]);
  });
});

describe("withService", () => {
  it("installs the service while the function runs and restores what was there", async () => {
    const outer = testService({}, parts);
    const inner = testService({}, parts);

    await withService(outer, async () => {
      const result = await withService(inner, async () => {
        expect(service.hooks).toBe(inner.hooks);
        return "done";
      });

      expect(result).toBe("done");
      expect(service.hooks).toBe(outer.hooks);
    });

    expect(() => service.hooks).toThrow("No service is installed");
  });

  it("restores the previous service when the function throws", async () => {
    await expect(
      withService(testService({}, parts), async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");

    expect(() => service.hooks).toThrow("No service is installed");
  });
});
