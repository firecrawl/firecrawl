import { fetchAudio } from "../audio";
import { MediaAccessDeniedError } from "../../error";
import { config } from "../../../../config";

describe("fetchAudio lockdown guard", () => {
  const originalFetch = global.fetch;
  const originalAvgrabServiceUrl = config.AVGRAB_SERVICE_URL;

  afterEach(() => {
    global.fetch = originalFetch;
    config.AVGRAB_SERVICE_URL = originalAvgrabServiceUrl;
    vi.clearAllMocks();
  });

  function mockSuccessfulAvgrab() {
    const fetchSpy = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith("/supported-urls")) {
        return {
          ok: true,
          json: async () => ({ regex: "https://example\\.com/audio" }),
        };
      }

      return {
        ok: true,
        json: async () => ({ public_url: "https://storage.example/audio.mp3" }),
      };
    });

    global.fetch = fetchSpy as any;
    config.AVGRAB_SERVICE_URL = "https://avgrab.example";
    return fetchSpy;
  }

  it("does not issue any fetch when lockdown is true, even if audio format is requested", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as any;

    const meta: any = {
      url: "https://example.com/audio",
      options: {
        lockdown: true,
        formats: [{ type: "audio" }],
      },
      logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    };
    const document: any = { markdown: "cached" };

    const result = await fetchAudio(meta, document);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toBe(document);
    expect(result.audio).toBeUndefined();
  });

  it("returns early when audio format is not requested regardless of lockdown", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as any;

    const meta: any = {
      url: "https://example.com/audio",
      options: {
        lockdown: false,
        formats: [{ type: "markdown" }],
      },
      logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    };
    const document: any = { markdown: "cached" };

    await fetchAudio(meta, document);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards browser cookies to avgrab when audio cookies are available", async () => {
    const fetchSpy = mockSuccessfulAvgrab();
    const cookies = [
      {
        name: "VISITOR_INFO1_LIVE",
        value: "visitor",
        domain: ".youtube.com",
        path: "/",
        secure: true,
        httpOnly: true,
      },
    ];

    const meta: any = {
      url: "https://example.com/audio",
      audioCookies: cookies,
      options: {
        lockdown: false,
        formats: [{ type: "audio" }],
      },
      logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    };
    const document: any = {};

    await fetchAudio(meta, document);

    const downloadCall = fetchSpy.mock.calls.find(([url]) =>
      String(url).endsWith("/download"),
    );
    expect(downloadCall).toBeDefined();
    const body = downloadCall![1]?.body;
    expect(typeof body).toBe("string");
    expect(JSON.parse(body as string)).toEqual({
      url: "https://example.com/audio",
      cookies,
    });
  });

  it("relays the message when the service reports a structured user-facing error", async () => {
    const fetchSpy = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith("/supported-urls")) {
        return {
          ok: true,
          json: async () => ({ regex: "https://example\\.com/audio" }),
        };
      }

      return {
        ok: false,
        status: 403,
        json: async () => ({
          detail: {
            code: "content_unavailable",
            message:
              "This content requires an authenticated session to access.",
          },
        }),
      };
    });
    global.fetch = fetchSpy as any;
    config.AVGRAB_SERVICE_URL = "https://avgrab.example";

    const meta: any = {
      url: "https://example.com/audio",
      options: {
        lockdown: false,
        formats: [{ type: "audio" }],
      },
      logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    };

    const error = await fetchAudio(meta, {} as any).catch(e => e);
    expect(error).toBeInstanceOf(MediaAccessDeniedError);
    expect(error.code).toBe("SCRAPE_MEDIA_ACCESS_DENIED");
    expect(error.message).toBe(
      "This content requires an authenticated session to access.",
    );
  });

  it("keeps the generic error for other service failures", async () => {
    const fetchSpy = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith("/supported-urls")) {
        return {
          ok: true,
          json: async () => ({ regex: "https://example\\.com/audio" }),
        };
      }

      return {
        ok: false,
        status: 400,
        json: async () => ({ detail: "Download failed: some other error" }),
      };
    });
    global.fetch = fetchSpy as any;
    config.AVGRAB_SERVICE_URL = "https://avgrab.example";

    const meta: any = {
      url: "https://example.com/audio",
      options: {
        lockdown: false,
        formats: [{ type: "audio" }],
      },
      logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    };

    const error = await fetchAudio(meta, {} as any).catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(MediaAccessDeniedError);
    expect(error.message).toBe(
      "Audio download failed: Download failed: some other error",
    );
  });

  it("omits cookies from the avgrab request when no audio cookies are available", async () => {
    const fetchSpy = mockSuccessfulAvgrab();

    const meta: any = {
      url: "https://example.com/audio",
      options: {
        lockdown: false,
        formats: [{ type: "audio" }],
      },
      logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    };
    const document: any = {};

    await fetchAudio(meta, document);

    const downloadCall = fetchSpy.mock.calls.find(([url]) =>
      String(url).endsWith("/download"),
    );
    expect(downloadCall).toBeDefined();
    const body = downloadCall![1]?.body;
    expect(typeof body).toBe("string");
    expect(JSON.parse(body as string)).toEqual({
      url: "https://example.com/audio",
    });
  });
});
