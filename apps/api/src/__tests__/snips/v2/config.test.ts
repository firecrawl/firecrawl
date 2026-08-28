import { afterAll, describe, expect, it, vi } from "vitest";

// config.ts runs `validatedConfigSchema.parse(process.env)` at import time, so
// each case sets the env then imports the module fresh via vi.resetModules().
// Modeled on the env-reload pattern in snips/v2/audio-routing.test.ts.
describe("config empty/whitespace OpenAI env vars (#4083)", () => {
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const originalOpenAiBaseUrl = process.env.OPENAI_BASE_URL;

  async function loadConfig() {
    vi.resetModules();
    const mod = await import("../../../config.js");
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

  it("deletes empty-string keys from process.env so the AI SDK env fallback cannot resurrect them", async () => {
    process.env.OPENAI_API_KEY = "";
    process.env.OPENAI_BASE_URL = "";
    await loadConfig();
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    expect(process.env.OPENAI_BASE_URL).toBeUndefined();
  });

  it("does not delete process.env when values are real", async () => {
    process.env.OPENAI_API_KEY = "sk-real-key";
    process.env.OPENAI_BASE_URL = "https://api.openai.com/v1";
    await loadConfig();
    expect(process.env.OPENAI_API_KEY).toBe("sk-real-key");
    expect(process.env.OPENAI_BASE_URL).toBe("https://api.openai.com/v1");
  });

  it("keeps whitespace-padded real values untrimmed", async () => {
    process.env.OPENAI_API_KEY = "  sk-key  ";
    process.env.OPENAI_BASE_URL = " https://api.openai.com/v1\n";
    const config = await loadConfig();
    expect(config.OPENAI_API_KEY).toBe("  sk-key  ");
    expect(config.OPENAI_BASE_URL).toBe(" https://api.openai.com/v1\n");
  });

  it("preserves FIREBRAIN_TRACKS whitespace semantics after helper consolidation", async () => {
    process.env.FIREBRAIN_TRACKS_URL = "   ";
    process.env.FIREBRAIN_TRACKS_API_KEY = "   ";
    const config = await loadConfig();
    expect(config.FIREBRAIN_TRACKS_URL).toBeUndefined();
    expect(config.FIREBRAIN_TRACKS_API_KEY).toBeUndefined();

    process.env.FIREBRAIN_TRACKS_URL = "https://tracks.example.com";
    process.env.FIREBRAIN_TRACKS_API_KEY = "sk-firebrain";
    const config2 = await loadConfig();
    expect(config2.FIREBRAIN_TRACKS_URL).toBe("https://tracks.example.com");
    expect(config2.FIREBRAIN_TRACKS_API_KEY).toBe("sk-firebrain");
  });
});
