import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it.each(["", "   "])(
  "loads the model providers when OPENAI_BASE_URL is %j",
  async value => {
    vi.stubEnv("OPENAI_BASE_URL", value);
    vi.resetModules();

    // Imported before anything else has loaded the config.
    await expect(import("../generic-ai.js")).resolves.toBeDefined();

    const { config } = await import("../../config.js");
    expect(config.OPENAI_BASE_URL).toBeUndefined();
  },
);

it("keeps an OPENAI_BASE_URL that is set", async () => {
  vi.stubEnv("OPENAI_BASE_URL", "http://localhost:11434/v1");
  vi.resetModules();

  const { config } = await import("../../config.js");

  expect(config.OPENAI_BASE_URL).toBe("http://localhost:11434/v1");
  expect(process.env.OPENAI_BASE_URL).toBe("http://localhost:11434/v1");
});
