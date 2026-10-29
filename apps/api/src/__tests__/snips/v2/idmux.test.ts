import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../../../config";
import { idmux } from "../lib";

const originalConfig = {
  IDMUX_URL: config.IDMUX_URL,
  TEST_API_KEY: config.TEST_API_KEY,
  TEST_TEAM_ID: config.TEST_TEAM_ID,
  TEST_SUITE_SELF_HOSTED: config.TEST_SUITE_SELF_HOSTED,
};

afterEach(() => {
  config.IDMUX_URL = originalConfig.IDMUX_URL;
  config.TEST_API_KEY = originalConfig.TEST_API_KEY;
  config.TEST_TEAM_ID = originalConfig.TEST_TEAM_ID;
  config.TEST_SUITE_SELF_HOSTED = originalConfig.TEST_SUITE_SELF_HOSTED;
  vi.restoreAllMocks();
});

describe("idmux", () => {
  it("falls back to the configured test identity when self-hosted idmux is unreachable", async () => {
    config.IDMUX_URL = "https://idmux.invalid";
    config.TEST_API_KEY = "test-api-key";
    config.TEST_TEAM_ID = "test-team-id";
    config.TEST_SUITE_SELF_HOSTED = true;

    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new TypeError("fetch failed"),
    );

    await expect(idmux({ name: "self-hosted-fallback" })).resolves.toEqual({
      apiKey: "test-api-key",
      teamId: "test-team-id",
    });
  });

  it("keeps production idmux failures strict", async () => {
    config.IDMUX_URL = "https://idmux.invalid";
    config.TEST_SUITE_SELF_HOSTED = undefined;

    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new TypeError("fetch failed"),
    );

    await expect(idmux({ name: "production-strict" })).rejects.toThrow(
      "fetch failed",
    );
  });
});
