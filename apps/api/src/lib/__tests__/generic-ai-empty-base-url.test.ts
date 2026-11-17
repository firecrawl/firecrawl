import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("loads the model providers with an empty OPENAI_BASE_URL", async () => {
  vi.stubEnv("OPENAI_BASE_URL", "");
  vi.resetModules();

  const { config } = await import("../../config.js");

  expect(config.OPENAI_BASE_URL).toBeUndefined();
  await expect(import("../generic-ai.js")).resolves.toBeDefined();
});

it("keeps an OPENAI_BASE_URL that is set", async () => {
  vi.stubEnv("OPENAI_BASE_URL", "http://localhost:11434/v1");
  vi.resetModules();

  const { config } = await import("../../config.js");

  expect(config.OPENAI_BASE_URL).toBe("http://localhost:11434/v1");
  expect(process.env.OPENAI_BASE_URL).toBe("http://localhost:11434/v1");
});
