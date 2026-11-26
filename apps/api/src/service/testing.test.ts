import express from "express";
import { describe, expect, it, vi } from "vitest";
import { logsMessages, memoryUploads, noBlocklist, openAuth } from "./defaults";
import { service } from "./service";
import type { CoreParts } from "./service";
import { testService, withService } from "./testing";

const parts: CoreParts = { core: { name: "core" }, logger: { error: vi.fn() } };

describe("testService", () => {
  it("replaces a module and adds extensions", async () => {
    const baseUploads = {
      driver: () => ({
        ...memoryUploads().driver(),
        name: "base-uploads",
      }),
    };
    const baseBlocklist = {
      ...noBlocklist(),
      isBlocked: (url: string) => url.includes("base-blocked.example"),
    };
    const base = {
      auth: openAuth("base-team"),
      blocklist: baseBlocklist,
      messages: logsMessages(),
      uploads: baseUploads,
    };
    const customMessages = {
      ...logsMessages(),
      errorContact: () => "Custom contact.",
    };
    const built = testService(base, parts, { messages: customMessages }, [
      { name: "extra" },
    ]);

    await expect(
      built.modules.auth.authenticate(express.request, { kind: "scrape" }),
    ).resolves.toEqual({ ok: true, caller: { teamId: "base-team" } });
    expect(
      built.modules.blocklist.isBlocked("https://base-blocked.example/x", {
        teamId: "t1",
        zeroDataRetention: false,
      }),
    ).toBe(true);
    expect(built.modules.messages.errorContact()).toBe("Custom contact.");
    expect(built.modules.uploads.driver().name).toBe("base-uploads");
    expect(built.describe().modules).toEqual([
      "auth",
      "billing",
      "blocklist",
      "idempotency",
      "jobStore",
      "limits",
      "messages",
      "policy",
      "uploads",
      "webhooks",
    ]);
    expect(built.describe().extensions).toEqual(["core", "extra"]);
  });

  it("keeps base modules when an override slot is explicitly undefined", () => {
    const baseMessages = {
      ...logsMessages(),
      errorContact: () => "Base contact.",
    };
    const built = testService({ messages: baseMessages }, parts, {
      messages: undefined,
    });

    expect(built.modules.messages.errorContact()).toBe("Base contact.");
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
