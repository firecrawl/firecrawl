import {
  shouldForceNonRender,
  scrapeURLWithFireEngineChromeCDP,
} from "../../scraper/scrapeURL/engines/fire-engine";
import { fireEngineScrape } from "../../scraper/scrapeURL/engines/fire-engine/scrape";
import { scrapeOptions } from "../../controllers/v2/types";
import { AbortManager } from "../../scraper/scrapeURL/lib/abortManager";

vi.mock("@mendable/firecrawl-rs", () => ({
  getInnerJson: vi.fn((x: string) => x),
}));

vi.mock("../../scraper/scrapeURL/engines/fire-engine/scrape", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../../scraper/scrapeURL/engines/fire-engine/scrape")>();
  return {
    ...actual,
    fireEngineScrape: vi.fn(),
  };
});

vi.mock("../../scraper/scrapeURL/engines/fire-engine/delete", () => ({
  fireEngineDelete: vi.fn().mockResolvedValue(undefined),
}));

const fmt = (types: string[]) => types.map(type => ({ type })) as any;

describe("shouldForceNonRender", () => {
  it("opts branding-only scrapes out of render routing", () => {
    expect(
      shouldForceNonRender({
        formats: fmt(["branding"]),
        youtubePostprocessorWillRun: false,
      }),
    ).toBe(true);
  });

  it("keeps render routing when a screenshot format is requested", () => {
    expect(
      shouldForceNonRender({
        formats: fmt(["branding", "screenshot"]),
        youtubePostprocessorWillRun: false,
      }),
    ).toBe(false);
  });

  it("keeps render routing when a screenshot action is requested", () => {
    expect(
      shouldForceNonRender({
        formats: fmt(["branding"]),
        actions: [{ type: "wait" }, { type: "screenshot" }],
        youtubePostprocessorWillRun: false,
      }),
    ).toBe(false);
  });

  it("still opts out with DOM-only user actions", () => {
    expect(
      shouldForceNonRender({
        formats: fmt(["branding"]),
        actions: [
          { type: "wait" },
          { type: "click" },
          { type: "scroll" },
          { type: "write" },
          { type: "press" },
          { type: "scrape" },
          { type: "executeJavascript" },
        ],
        youtubePostprocessorWillRun: false,
      }),
    ).toBe(true);
  });

  it("keeps render routing for unknown/future action types (fail safe)", () => {
    expect(
      shouldForceNonRender({
        formats: fmt(["branding"]),
        actions: [{ type: "someFutureVisualAction" }],
        youtubePostprocessorWillRun: false,
      }),
    ).toBe(false);
  });

  it("keeps render routing when a pdf action is requested", () => {
    expect(
      shouldForceNonRender({
        formats: fmt(["branding"]),
        actions: [{ type: "pdf" }],
        youtubePostprocessorWillRun: false,
      }),
    ).toBe(false);
  });

  it("keeps render routing for audio/video formats", () => {
    expect(
      shouldForceNonRender({
        formats: fmt(["branding", "audio"]),
        youtubePostprocessorWillRun: false,
      }),
    ).toBe(false);
    expect(
      shouldForceNonRender({
        formats: fmt(["branding", "video"]),
        youtubePostprocessorWillRun: false,
      }),
    ).toBe(false);
  });

  it("keeps render routing when the media postprocessor will run", () => {
    expect(
      shouldForceNonRender({
        formats: fmt(["branding"]),
        youtubePostprocessorWillRun: true,
      }),
    ).toBe(false);
  });

  it("does nothing for non-branding scrapes", () => {
    expect(
      shouldForceNonRender({
        formats: fmt(["markdown"]),
        youtubePostprocessorWillRun: false,
      }),
    ).toBe(false);
    expect(
      shouldForceNonRender({
        formats: fmt(["markdown"]),
        actions: [{ type: "wait" }],
        youtubePostprocessorWillRun: false,
      }),
    ).toBe(false);
  });
});

describe("fire-engine screenshot/fullPage forwarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (fireEngineScrape as ReturnType<typeof vi.fn>).mockResolvedValue({
      timeTaken: 1,
      content: "<html><body>Hello</body></html>",
      url: "https://example.com",
      pageStatusCode: 200,
      responseHeaders: { "content-type": "text/html" },
      screenshots: [
        "https://service.firecrawl.dev/storage/v1/object/public/media/test-screenshot",
      ],
    });
  });

  function buildMeta(options: any) {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      child: vi.fn(function () {
        return logger;
      }),
    };

    return {
      id: "test-screenshot-fullpage",
      url: "https://example.com",
      options,
      internalOptions: { teamId: "test", orgId: null },
      logger,
      abort: new AbortManager(),
      featureFlags: new Set(),
      mock: null,
      pdfPrefetch: undefined,
      documentPrefetch: undefined,
      fetchPrefetch: undefined,
      costTracking: {},
      threatDecisions: [],
    } as any;
  }

  it("sets screenshot and fullPage on the Fire Engine request for a full-page screenshot format", async () => {
    const meta = buildMeta(
      scrapeOptions.parse({
        formats: [{ type: "screenshot" as const, fullPage: true }],
      }),
    );

    await scrapeURLWithFireEngineChromeCDP(meta);

    expect(fireEngineScrape).toHaveBeenCalledTimes(1);
    const request = (fireEngineScrape as ReturnType<typeof vi.fn>).mock
      .calls[0][2];
    expect(request.screenshot).toBe(true);
    expect(request.fullPage).toBe(true);
    expect(request.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "screenshot", fullPage: true }),
      ]),
    );
  });

  it("sets screenshot and fullPage on the Fire Engine request for a screenshot action with fullPage", async () => {
    const meta = buildMeta(
      scrapeOptions.parse({
        actions: [{ type: "screenshot" as const, fullPage: true }],
      }),
    );

    await scrapeURLWithFireEngineChromeCDP(meta);

    expect(fireEngineScrape).toHaveBeenCalledTimes(1);
    const request = (fireEngineScrape as ReturnType<typeof vi.fn>).mock
      .calls[0][2];
    expect(request.screenshot).toBe(true);
    expect(request.fullPage).toBe(true);
    expect(request.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "screenshot", fullPage: true }),
      ]),
    );
  });
});
