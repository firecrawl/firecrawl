import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../../../config";
import { idmux } from "../lib";

const originalConfig = {
  TEST_API_KEY: config.TEST_API_KEY,
  TEST_SUITE_SELF_HOSTED: config.TEST_SUITE_SELF_HOSTED,
};
const originalEnv = {
  IDMUX_URL: process.env.IDMUX_URL,
  TEST_TEAM_ID: process.env.TEST_TEAM_ID,
};

afterEach(() => {
  config.TEST_API_KEY = originalConfig.TEST_API_KEY;
  config.TEST_SUITE_SELF_HOSTED = originalConfig.TEST_SUITE_SELF_HOSTED;
  if (originalEnv.IDMUX_URL === undefined) {
    delete process.env.IDMUX_URL;
  } else {
    process.env.IDMUX_URL = originalEnv.IDMUX_URL;
  }
  if (originalEnv.TEST_TEAM_ID === undefined) {
    delete process.env.TEST_TEAM_ID;
  } else {
    process.env.TEST_TEAM_ID = originalEnv.TEST_TEAM_ID;
  }
  vi.restoreAllMocks();
});

describe("idmux", () => {
  it("falls back to the configured test identity when self-hosted idmux is unreachable", async () => {
    process.env.IDMUX_URL = "https://idmux.invalid";
    config.TEST_API_KEY = "test-api-key";
    process.env.TEST_TEAM_ID = "test-team-id";
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
    process.env.IDMUX_URL = "https://idmux.invalid";
    config.TEST_SUITE_SELF_HOSTED = undefined;

    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new TypeError("fetch failed"),
    );

    await expect(idmux({ name: "production-strict" })).rejects.toThrow(
      "fetch failed",
    );
  });
});
