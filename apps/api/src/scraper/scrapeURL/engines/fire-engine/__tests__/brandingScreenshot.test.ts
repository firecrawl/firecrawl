import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  requests: [] as any[],
  response: (_request: any) => ({}) as Record<string, unknown>,
}));

vi.mock("../scrape", async importOriginal => ({
  ...(await importOriginal<typeof import("../scrape")>()),
  fireEngineScrape: vi.fn(
    async (_meta: unknown, _logger: unknown, request: unknown) => {
      fake.requests.push(request);
      return fake.response(request);
    },
  ),
}));

import { config } from "../../../../../config";
import { scrapeURLWithFireEngineChromeCDP } from "../index";
import { brandingScreenshotCapturesTotal } from "../../../../../lib/branding/metrics";

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child() {
    return this;
  },
} as any;

function meta(
  formats: any[],
  extra: { zeroDataRetention?: boolean; actions?: any[] } = {},
) {
  return {
    id: "scrape-1",
    url: "https://example.com",
    options: {
      formats,
      actions: extra.actions,
      skipTlsVerification: false,
    },
    internalOptions: {
      teamId: "team-a",
      zeroDataRetention: extra.zeroDataRetention ?? false,
    },
    logger,
    abort: {
      scrapeTimeout: () => 30000,
      asSignal: () => undefined,
      throwIfAborted: () => {},
    },
    featureFlags: new Set(),
    mock: null,
  } as any;
}

/** Screenshots in the order the request's screenshot actions take them, each
 * reported against its action's index like fire-engine does. Actions matching
 * `skip` get no result. */
const respondWith = (
  shots: string[],
  skip: (action: any) => boolean = () => false,
) => {
  fake.response = (request: any) => {
    const queue = [...shots];
    const actionResults = (request.actions ?? []).flatMap(
      (a: any, idx: number) =>
        a.type === "screenshot" && !skip(a)
          ? [{ idx, type: "screenshot", result: { path: queue.shift() } }]
          : [],
    );
    return {
      url: "https://example.com",
      content: "<html><body>hi</body></html>",
      pageStatusCode: 200,
      responseHeaders: { "content-type": "text/html" },
      screenshots: actionResults.map((r: any) => r.result.path),
      actionResults,
    };
  };
};

// Branding with the experimental first-screen flag.
const SHOT_BRANDING = { type: "branding", __experimental_screenshot: true };

const sent = () => fake.requests[0].actions as any[];

describe("branding first-screen screenshot", () => {
  const saved = {
    key: config.TYPESAFE_API_KEY,
    jev: config.BRANDING_JEV,
    percent: config.BRANDING_JEV_SCREENSHOT_PERCENT,
  };

  beforeEach(() => {
    fake.requests = [];
    config.TYPESAFE_API_KEY = "ts-test";
    config.BRANDING_JEV = undefined;
    config.BRANDING_JEV_SCREENSHOT_PERCENT = 0;
  });

  afterEach(() => {
    config.TYPESAFE_API_KEY = saved.key;
    config.BRANDING_JEV = saved.jev;
    config.BRANDING_JEV_SCREENSHOT_PERCENT = saved.percent;
  });

  it("captures for teams in the rollout without the flag, unless the request opts out", async () => {
    const via = async (v: string) =>
      (await brandingScreenshotCapturesTotal.get()).values.find(
        x => x.labels.outcome === "captured" && x.labels.via === v,
      )?.value ?? 0;
    const before = await via("rollout");
    config.BRANDING_JEV_SCREENSHOT_PERCENT = 100;

    respondWith(["https://storage.example/branding.jpg"]);
    const result = await scrapeURLWithFireEngineChromeCDP(
      meta([{ type: "branding" }]),
    );
    expect(result.brandingScreenshot).toBe(
      "https://storage.example/branding.jpg",
    );
    expect(await via("rollout")).toBe(before + 1);

    fake.requests = [];
    respondWith([]);
    const optedOut = await scrapeURLWithFireEngineChromeCDP(
      meta([{ type: "branding", __experimental_screenshot: false }]),
    );
    expect((sent() ?? []).some(a => a.type === "screenshot")).toBe(false);
    expect(optedOut.brandingScreenshot).toBeUndefined();
  });

  it("captures a JPEG first screen after the branding scan and keeps it out of the document", async () => {
    respondWith(["https://storage.example/branding.jpg"]);

    const result = await scrapeURLWithFireEngineChromeCDP(
      meta([SHOT_BRANDING]),
    );

    const types = sent().map(a => a.type);
    const scan = types.indexOf("executeJavascript");
    expect(types.slice(scan)).toEqual(["executeJavascript", "screenshot"]);
    expect(sent()[scan + 1]).toMatchObject({
      fullPage: false,
      quality: 70,
      viewport: { width: 1280, height: 720 },
    });
    expect(result.brandingScreenshot).toBe(
      "https://storage.example/branding.jpg",
    );
    expect(result.screenshot).toBeUndefined();
    expect(result.actions?.screenshots).toEqual([]);
  });

  it("leaves the screenshot format and the user's own screenshots alone", async () => {
    respondWith([
      "https://storage.example/user-action.png",
      "https://storage.example/format.png",
      "https://storage.example/branding.jpg",
    ]);

    const result = await scrapeURLWithFireEngineChromeCDP(
      meta([SHOT_BRANDING, { type: "screenshot" }], {
        actions: [{ type: "screenshot", fullPage: false }],
      }),
    );

    expect(result.brandingScreenshot).toBe(
      "https://storage.example/branding.jpg",
    );
    expect(result.screenshot).toBe("https://storage.example/format.png");
    expect(result.actions?.screenshots).toEqual([
      "https://storage.example/user-action.png",
    ]);
  });

  it("never takes a caller's screenshot for its own when its capture has no result", async () => {
    respondWith(
      ["https://storage.example/format.png"],
      a => a.metadata?.__firecrawl_internal,
    );

    const result = await scrapeURLWithFireEngineChromeCDP(
      meta([SHOT_BRANDING, { type: "screenshot" }]),
    );

    expect(result.brandingScreenshot).toBeUndefined();
    expect(result.screenshot).toBe("https://storage.example/format.png");
  });

  it("counts whether fire-engine returned the capture", async () => {
    const count = async (outcome: string) =>
      (await brandingScreenshotCapturesTotal.get()).values.find(
        v => v.labels.outcome === outcome && v.labels.via === "flag",
      )?.value ?? 0;
    const before = {
      captured: await count("captured"),
      missing: await count("missing"),
    };

    respondWith(["https://storage.example/branding.jpg"]);
    await scrapeURLWithFireEngineChromeCDP(meta([SHOT_BRANDING]));
    fake.requests = [];
    respondWith([], a => a.metadata?.__firecrawl_internal);
    await scrapeURLWithFireEngineChromeCDP(meta([SHOT_BRANDING]));

    expect(await count("captured")).toBe(before.captured + 1);
    expect(await count("missing")).toBe(before.missing + 1);
  });

  it("counts a requested capture whose scrape failed apart from a missing one", async () => {
    const failed = async () =>
      (await brandingScreenshotCapturesTotal.get()).values.find(
        v => v.labels.outcome === "scrape_failed" && v.labels.via === "flag",
      )?.value ?? 0;
    const before = await failed();
    fake.response = () => {
      throw new Error("engine down");
    };

    await expect(
      scrapeURLWithFireEngineChromeCDP(meta([SHOT_BRANDING])),
    ).rejects.toThrow("engine down");
    expect(await failed()).toBe(before + 1);
  });

  it("captures nothing for zero data retention, branding without the flag, when Jev is off, or without branding", async () => {
    const cases = [
      () => meta([SHOT_BRANDING], { zeroDataRetention: true }),
      // branding without the flag
      () => meta([{ type: "branding" }]),
      () => {
        config.BRANDING_JEV = false;
        return meta([SHOT_BRANDING]);
      },
      () => meta([{ type: "markdown" }]),
    ];
    for (const make of cases) {
      // each case starts from the defaults
      config.BRANDING_JEV = undefined;
      fake.requests = [];
      respondWith([]);
      const result = await scrapeURLWithFireEngineChromeCDP(make());
      expect((sent() ?? []).some(a => a.type === "screenshot")).toBe(false);
      expect(result.brandingScreenshot).toBeUndefined();
    }
  });
});
