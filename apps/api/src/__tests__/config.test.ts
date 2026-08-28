import { afterAll, describe, expect, it, vi } from "vitest";

// config.ts runs `validatedConfigSchema.parse(process.env)` at import time, so
// each case sets the env then imports the module fresh via vi.resetModules().
// Modeled on the env-reload pattern in snips/v2/audio-routing.test.ts.
describe("config emptyStringAsUndefined (OPENAI_API_KEY / OPENAI_BASE_URL)", () => {
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const originalOpenAiBaseUrl = process.env.OPENAI_BASE_URL;

  async function loadConfig() {
    vi.resetModules();
    const mod = await import("../config.js");
    return mod.config;
  }

  afterAll(() => {
    if (originalOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    }
    if (originalOpenAiBaseUrl === undefined) {
      delete process.env.OPENAI_BASE_URL;
    } else {
      process.env.OPENAI_BASE_URL = originalOpenAiBaseUrl;
    }
  });

  it("treats an empty string as undefined (docker-compose ${VAR} passthrough)", async () => {
    process.env.OPENAI_API_KEY = "";
    process.env.OPENAI_BASE_URL = "";
    const config = await loadConfig();
    expect(config.OPENAI_API_KEY).toBeUndefined();
    expect(config.OPENAI_BASE_URL).toBeUndefined();
  });

  it("treats whitespace-only strings as undefined", async () => {
    process.env.OPENAI_API_KEY = "   ";
    process.env.OPENAI_BASE_URL = "\t\n ";
    const config = await loadConfig();
    expect(config.OPENAI_API_KEY).toBeUndefined();
    expect(config.OPENAI_BASE_URL).toBeUndefined();
  });

  it("passes real values through unchanged", async () => {
    process.env.OPENAI_API_KEY = "sk-real-key";
    process.env.OPENAI_BASE_URL = "https://api.openai.com/v1";
    const config = await loadConfig();
    expect(config.OPENAI_API_KEY).toBe("sk-real-key");
    expect(config.OPENAI_BASE_URL).toBe("https://api.openai.com/v1");
  });

  it("leaves unset vars undefined", async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    const config = await loadConfig();
    expect(config.OPENAI_API_KEY).toBeUndefined();
    expect(config.OPENAI_BASE_URL).toBeUndefined();
  });
});
