import { afterEach, describe, expect, it, vi } from "vitest";

async function loadIntegrationId(
  value: string | undefined,
): Promise<string | undefined> {
  vi.stubEnv("VERCEL_MARKETPLACE_INTEGRATION_ID", value);
  vi.resetModules();
  const { config } = await import("../../config.js");
  return config.VERCEL_MARKETPLACE_INTEGRATION_ID;
}

describe("VERCEL_MARKETPLACE_INTEGRATION_ID config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("defaults to Firecrawl's integration when unset", async () => {
    expect(await loadIntegrationId(undefined)).toBe(
      "oac_jkJx3wOqOMTpj4TqJJcwA4l8",
    );
  });

  it("is disabled when explicitly empty", async () => {
    expect(await loadIntegrationId("")).toBeUndefined();
  });

  it("uses the env value when set", async () => {
    expect(await loadIntegrationId("oac_other123")).toBe("oac_other123");
  });

  it("rejects a malformed id", async () => {
    await expect(loadIntegrationId("not-an-id")).rejects.toThrow();
  });
});
