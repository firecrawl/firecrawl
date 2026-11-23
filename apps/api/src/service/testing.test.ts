import { describe, expect, it, vi } from "vitest";
import { service, type CoreParts, type Modules } from "./service";
import { testService, withService } from "./testing";

const parts: CoreParts = { core: { name: "core" }, logger: { error: vi.fn() } };

// No slot exists yet, so a module can only be listed through a cast.
const modules = (listed: Record<string, unknown>) => listed as Modules;

describe("testService", () => {
  it("replaces a module and adds extensions", () => {
    const built = testService(
      modules({ kept: "base", replaced: "base" }),
      parts,
      modules({ replaced: "override" }),
      [{ name: "extra" }],
    );

    expect(built.modules).toEqual({ kept: "base", replaced: "override" });
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
