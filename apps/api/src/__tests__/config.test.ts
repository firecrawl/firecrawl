import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// config.ts runs `configSchema.parse(process.env)` at import time, so each case
// sets the env then imports the module fresh via vi.resetModules().
describe("config emptyStringAsUndefined (OPENAI_API_KEY / OPENAI_BASE_URL)", () => {
  const original = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...original };
  });

  async function loadConfig() {
    const mod = await import("../config");
    return mod.config;
  }

  it("treats an empty string as undefined", async () => {
    process.env.OPENAI_API_KEY = "";
    process.env.OPENAI_BASE_URL = "";
    const config = await loadConfig();
    expect(config.OPENAI_API_KEY).toBeUndefined();
    expect(config.OPENAI_BASE_URL).toBeUndefined();
  });

  it("treats a whitespace-only string as undefined", async () => {
    process.env.OPENAI_API_KEY = "   ";
    process.env.OPENAI_BASE_URL = "\t\n ";
    const config = await loadConfig();
    expect(config.OPENAI_API_KEY).toBeUndefined();
    expect(config.OPENAI_BASE_URL).toBeUndefined();
  });

  it("passes a real value through unchanged", async () => {
    process.env.OPENAI_API_KEY = "sk-real-key";
    process.env.OPENAI_BASE_URL = "https://api.openai.com/v1";
    const config = await loadConfig();
    expect(config.OPENAI_API_KEY).toBe("sk-real-key");
    expect(config.OPENAI_BASE_URL).toBe("https://api.openai.com/v1");
  });
});
