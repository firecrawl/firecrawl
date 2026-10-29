import { vi } from "vitest";

vi.mock("../../config", () => ({
  config: {
    FIREBRAIN_TRACKS_URL: "https://tracks.example.test/store",
    FIREBRAIN_TRACKS_API_KEY: "fb_test_key",
  },
}));

vi.mock("../../lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { trackEvent } from "./tracking";
import { config } from "../../config";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

beforeEach(() => {
  vi.clearAllMocks();
  (config as any).FIREBRAIN_TRACKS_URL = "https://tracks.example.test/store";
  (config as any).FIREBRAIN_TRACKS_API_KEY = "fb_test_key";
});

describe("trackEvent", () => {
  it("POSTs the firecrawl-api envelope and returns the track uuid on success", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ tracks: [{ track_uuid: "uuid-1" }] }),
      text: async () => "",
    });

    const result = await trackEvent("concurrent-browser-limit-reached", {
      team_id: "team_1",
    });

    expect(result).toBe("uuid-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://tracks.example.test/store");
    expect(init.headers.authorization).toBe("Bearer fb_test_key");
    expect(JSON.parse(init.body)).toEqual({
      definition: "concurrent-browser-limit-reached",
      source: "firecrawl-api",
      properties: { team_id: "team_1" },
    });
  });

  it("returns null without throwing on a non-2xx response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "upstream error",
      json: async () => ({}),
    });

    await expect(
      trackEvent("concurrent-browser-limit-reached", { team_id: "team_1" }),
    ).resolves.toBeNull();
  });

  it("skips the request and returns null when the endpoint is unconfigured", async () => {
    (config as any).FIREBRAIN_TRACKS_URL = undefined;

    const result = await trackEvent("concurrent-browser-limit-reached", {
      team_id: "team_1",
    });

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
