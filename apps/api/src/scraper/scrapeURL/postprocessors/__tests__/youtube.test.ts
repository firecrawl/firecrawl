import { youtubePostprocessor } from "../youtube";
import { config } from "../../../../config";

describe("youtubePostprocessor maxAge forwarding to avgrab", () => {
  const originalFetch = global.fetch;
  const originalUrl = config.AVGRAB_SERVICE_URL;
  const engineResult: any = {
    url: "https://www.youtube.com/watch?v=H4fUJQCIV5E",
    markdown: "x",
  };
  const metaBase = {
    logger: {
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      child: () => metaBase.logger,
    },
  };

  afterEach(() => {
    global.fetch = originalFetch;
    config.AVGRAB_SERVICE_URL = originalUrl;
    vi.clearAllMocks();
  });

  function mockMetadata() {
    const spy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ uploaded_by: {}, transcript: "hi", title: "t" }),
    }));
    global.fetch = spy as any;
    config.AVGRAB_SERVICE_URL = "https://avgrab.example";
    return spy;
  }

  async function runWith(maxAge: number | undefined) {
    const spy = mockMetadata();
    const meta: any = {
      ...metaBase,
      url: engineResult.url,
      options: { lockdown: false, maxAge, location: undefined },
    };
    // We only assert the outgoing request body; the mocked response may fail
    // later shape validation, which is irrelevant here.
    await youtubePostprocessor.run(meta, engineResult).catch(() => {});
    const call = spy.mock.calls.find(([u]: any[]) =>
      String(u).endsWith("/metadata"),
    );
    return JSON.parse(call![1].body as string);
  }

  it("forwards maxAge:0 as max_age_seconds:0 (probe cache bypass)", async () => {
    const body = await runWith(0);
    expect(body.max_age_seconds).toBe(0);
  });

  it("converts maxAge ms to seconds", async () => {
    const body = await runWith(3_600_000);
    expect(body.max_age_seconds).toBe(3600);
  });

  it("omits max_age_seconds when maxAge is unset (default TTL applies)", async () => {
    const body = await runWith(undefined);
    expect("max_age_seconds" in body).toBe(false);
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
