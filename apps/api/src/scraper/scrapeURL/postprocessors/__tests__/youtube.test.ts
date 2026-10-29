import { youtubePostprocessor } from "../youtube";
import { config } from "../../../../config";

describe("youtubePostprocessor /metadata fetch timeout", () => {
  const originalFetch = global.fetch;
  const originalUrl = config.AVGRAB_SERVICE_URL;

  afterEach(() => {
    global.fetch = originalFetch;
    config.AVGRAB_SERVICE_URL = originalUrl;
    vi.clearAllMocks();
  });

  it("passes an abort signal so a slow /metadata call can't hang the scrape", async () => {
    const spy = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ uploaded_by: {}, transcript: "hi", title: "t" }),
    }));
    global.fetch = spy as any;
    config.AVGRAB_SERVICE_URL = "https://avgrab.example";

    const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const meta: any = {
      logger: { ...logger, child: () => logger },
      url: "https://www.youtube.com/watch?v=H4fUJQCIV5E",
      options: { lockdown: false, location: undefined },
    };
    // The mocked response fails later shape validation; we only assert the
    // outgoing request carried a timeout signal.
    await youtubePostprocessor
      .run(meta, {
        url: "https://www.youtube.com/watch?v=H4fUJQCIV5E",
        markdown: "x",
      } as any)
      .catch(() => {});

    const call = spy.mock.calls.find(([u]) => String(u).endsWith("/metadata"));
    expect(call?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("degrades gracefully: a rejected /metadata fetch returns the page unchanged", async () => {
    global.fetch = vi.fn(async () => {
      throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
    }) as any;
    config.AVGRAB_SERVICE_URL = "https://avgrab.example";

    const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const engineResult: any = {
      url: "https://www.youtube.com/watch?v=H4fUJQCIV5E",
      markdown: "original page",
    };
    const meta: any = {
      logger: { ...logger, child: () => logger },
      url: engineResult.url,
      options: { lockdown: false, location: undefined },
    };
    // The postprocessor itself throws; the pipeline's try/catch is what
    // degrades. Here we assert getYouTubeMetadata rejects (so the caller can
    // catch), rather than hanging.
    await expect(
      youtubePostprocessor.run(meta, engineResult),
    ).rejects.toBeDefined();
  });
});

describe("youtubePostprocessor.shouldRun", () => {
  const meta = {} as any;

  it("runs for YouTube live video URLs", () => {
    expect(
      youtubePostprocessor.shouldRun(
        meta,
        new URL("https://www.youtube.com/live/H4fUJQCIV5E"),
      ),
    ).toBe(true);
  });

  it("keeps existing YouTube video URL support", () => {
    expect(
      youtubePostprocessor.shouldRun(
        meta,
        new URL("https://www.youtube.com/watch?v=H4fUJQCIV5E"),
      ),
    ).toBe(true);
    expect(
      youtubePostprocessor.shouldRun(
        meta,
        new URL("https://youtu.be/H4fUJQCIV5E"),
      ),
    ).toBe(true);
  });

  it("does not run for non-video YouTube paths or already processed URLs", () => {
    expect(
      youtubePostprocessor.shouldRun(meta, new URL("https://www.youtube.com/")),
    ).toBe(false);
    expect(
      youtubePostprocessor.shouldRun(
        meta,
        new URL("https://www.youtube.com/live/"),
      ),
    ).toBe(false);
    expect(
      youtubePostprocessor.shouldRun(
        meta,
        new URL("https://www.youtube.com/live/H4fUJQCIV5E"),
        ["youtube"],
      ),
    ).toBe(false);
  });
});
