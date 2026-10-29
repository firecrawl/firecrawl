import { afterEach, describe, expect, it, vi } from "vitest";

async function loadIssuer(value: string | undefined): Promise<string> {
  vi.stubEnv("WORLD_ID_ISSUER", value);
  vi.resetModules();
  const { config } = await import("../../config.js");
  return config.WORLD_ID_ISSUER;
}

describe("WORLD_ID_ISSUER config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("defaults to World's issuer when unset", async () => {
    expect(await loadIssuer(undefined)).toBe("https://auth.world.org");
  });

  it("defaults to World's issuer when empty", async () => {
    expect(await loadIssuer("")).toBe("https://auth.world.org");
  });

  it("uses the env value when set", async () => {
    expect(await loadIssuer("https://issuer.example")).toBe(
      "https://issuer.example",
    );
  });

  it("rejects a non-https issuer", async () => {
    await expect(loadIssuer("http://issuer.example")).rejects.toThrow(
      "WORLD_ID_ISSUER must be an https URL",
    );
  });
});
