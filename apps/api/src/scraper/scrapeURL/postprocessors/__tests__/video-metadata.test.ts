import {
  videoMetadataPostprocessor,
  resetVideoMetadataCacheForTests,
} from "../video-metadata";
import { config } from "../../../../config";

const METADATA_REGEX =
  "https?://(?:[a-zA-Z0-9-]+\\.)*(?:(?:youtube\\.com/watch\\?.*v=)|(?:youtube\\.com/live/))[a-zA-Z0-9_-]+|https?://youtu\\.be/[a-zA-Z0-9_-]+";

describe("videoMetadataPostprocessor.shouldRun", () => {
  const originalFetch = global.fetch;
  const originalAvgrabServiceUrl = config.AVGRAB_SERVICE_URL;

  const meta = (overrides: Record<string, unknown> = {}) =>
    ({
      options: { lockdown: false },
      logger: { warn: vi.fn() },
      ...overrides,
    }) as any;

  afterEach(() => {
    global.fetch = originalFetch;
    config.AVGRAB_SERVICE_URL = originalAvgrabServiceUrl;
    resetVideoMetadataCacheForTests();
    vi.clearAllMocks();
  });

  function mockSupportedUrls() {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        regex: "unused",
        resolve_regex: "unused",
        metadata_regex: METADATA_REGEX,
      }),
    }));
    global.fetch = fetchSpy as any;
    config.AVGRAB_SERVICE_URL = "https://avgrab.example";
    return fetchSpy;
  }

  it("runs for URLs matching avgrab's metadata_regex", async () => {
    mockSupportedUrls();

    for (const url of [
      "https://www.youtube.com/watch?v=H4fUJQCIV5E",
      "https://m.youtube.com/watch?v=H4fUJQCIV5E",
      "https://www.youtube.com/live/H4fUJQCIV5E",
      "https://youtu.be/H4fUJQCIV5E",
    ]) {
      expect(
        await videoMetadataPostprocessor.shouldRun(meta(), new URL(url)),
      ).toBe(true);
    }
  });

  it("does not run for non-matching URLs", async () => {
    mockSupportedUrls();

    for (const url of [
      "https://www.youtube.com/",
      "https://www.youtube.com/live/",
      "https://example.com/watch?v=H4fUJQCIV5E",
    ]) {
      expect(
        await videoMetadataPostprocessor.shouldRun(meta(), new URL(url)),
      ).toBe(false);
    }
  });

  it("caches the pattern between checks", async () => {
    const fetchSpy = mockSupportedUrls();

    const url = new URL("https://www.youtube.com/watch?v=H4fUJQCIV5E");
    await videoMetadataPostprocessor.shouldRun(meta(), url);
    await videoMetadataPostprocessor.shouldRun(meta(), url);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not run in lockdown mode", async () => {
    const fetchSpy = mockSupportedUrls();

    expect(
      await videoMetadataPostprocessor.shouldRun(
        meta({ options: { lockdown: true } }),
        new URL("https://www.youtube.com/watch?v=H4fUJQCIV5E"),
      ),
    ).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not run when AVGRAB_SERVICE_URL is not configured", async () => {
    config.AVGRAB_SERVICE_URL = undefined;

    expect(
      await videoMetadataPostprocessor.shouldRun(
        meta(),
        new URL("https://www.youtube.com/watch?v=H4fUJQCIV5E"),
      ),
    ).toBe(false);
  });

  it("fails closed when avgrab is unreachable", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("connection refused");
    }) as any;
    config.AVGRAB_SERVICE_URL = "https://avgrab.example";

    const m = meta();
    expect(
      await videoMetadataPostprocessor.shouldRun(
        m,
        new URL("https://www.youtube.com/watch?v=H4fUJQCIV5E"),
      ),
    ).toBe(false);
    expect(m.logger.warn).toHaveBeenCalled();
  });
});
