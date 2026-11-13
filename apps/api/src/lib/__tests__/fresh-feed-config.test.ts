import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("loads the config with an empty FRESH_FEED_URL and leaves it unset", async () => {
  vi.stubEnv("FRESH_FEED_URL", "");
  vi.resetModules();

  const { config } = await import("../../config.js");

  expect(config.FRESH_FEED_URL).toBeUndefined();
});
