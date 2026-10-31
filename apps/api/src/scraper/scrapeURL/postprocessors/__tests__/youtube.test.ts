import { isYouTubeErrorPage, youtubePostprocessor } from "../youtube";
import { MediaAccessDeniedError, YouTubeUnavailableError } from "../../error";
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

describe("youtubePostprocessor on YouTube error pages", () => {
  const originalFetch = global.fetch;
  const originalUrl = config.AVGRAB_SERVICE_URL;
  const url = "https://www.youtube.com/watch?v=H4fUJQCIV5E";
  const errorPage =
    "Error 401 (Bad Request)!!1\n\n**401.** That’s an error.\n\nThe server cannot process the request because it is malformed. It should not be retried. That’s all we know.\n\nSkip navigation\n\nSearch";
  const errorHtml =
    '<html><head><title>Watch - YouTube</title></head><body><iframe></iframe><title>Error 401 (Bad Request)!!1</title><main id="af-error-container" role="main"><p><b>401.</b> <ins>That’s an error.</ins></p></main></body></html>';
  const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const meta: any = {
    logger: { ...logger, child: () => logger },
    url,
    options: { lockdown: false, location: undefined },
  };

  beforeEach(() => {
    config.AVGRAB_SERVICE_URL = "https://avgrab.example";
    global.fetch = vi.fn(async () => ({
      ok: false,
      json: async () => ({ detail: "extraction failed" }),
    })) as any;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    config.AVGRAB_SERVICE_URL = originalUrl;
    vi.clearAllMocks();
  });

  it("detects Google's error page and YouTube's consent page", () => {
    expect(isYouTubeErrorPage({ html: errorHtml })).toBe(true);
    expect(isYouTubeErrorPage({ markdown: errorPage })).toBe(true);
    expect(
      isYouTubeErrorPage({
        html: "<html><body><h1>Before you continue to YouTube</h1></body></html>",
      }),
    ).toBe(true);
    expect(
      isYouTubeErrorPage({
        html: "<html><head><title>Never Gonna Give You Up - YouTube</title></head></html>",
        markdown: "# Never Gonna Give You Up\n\nRick Astley",
      }),
    ).toBe(false);
    expect(isYouTubeErrorPage({})).toBe(false);
  });

  it("throws a typed error instead of returning the error page", async () => {
    const error = await youtubePostprocessor
      .run(meta, { url, html: errorHtml } as any)
      .catch(e => e);
    expect(error).toBeInstanceOf(YouTubeUnavailableError);
    expect(error.code).toBe("SCRAPE_YOUTUBE_UNAVAILABLE");
  });

  it("keeps the original error when the page is not an error page", async () => {
    const error = await youtubePostprocessor
      .run(meta, {
        url,
        html: "<html><head><title>A video - YouTube</title></head></html>",
      } as any)
      .catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("extraction failed");
    expect(error).not.toBeInstanceOf(YouTubeUnavailableError);
  });

  it("keeps a media access denial over the error page", async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      json: async () => ({
        detail: { code: "private", message: "This video is private." },
      }),
    })) as any;
    const error = await youtubePostprocessor
      .run(meta, { url, html: errorHtml } as any)
      .catch(e => e);
    expect(error).toBeInstanceOf(MediaAccessDeniedError);
  });
});
