import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { generateObject } from "ai";
import { APITimeoutError, RateLimitError } from "@typesafe-ai/sdk";

const mocks = vi.hoisted(() => ({ systemOne: vi.fn() }));

vi.mock("@typesafe-ai/sdk", async importOriginal => ({
  ...(await importOriginal<typeof import("@typesafe-ai/sdk")>()),
  TypeSafeClient: class {
    systemOne = mocks.systemOne;
  },
}));
vi.mock("ai", async importOriginal => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateObject: vi.fn(),
}));
vi.mock("../../../lib/generic-ai", () => ({
  getModel: vi.fn((name: string) => ({ modelId: name })),
}));

import { config } from "../../../config";
import {
  buildJevRequest,
  cleanFontFamily,
  describeColor,
  loadFirstScreen,
  resetJevBreaker,
  wantsBrandingScreenshot,
} from "../../../lib/branding/jev";
import { enhanceBrandingWithLLM } from "../../../lib/branding/llm";
import { brandingJevScreenshotTotal } from "../../../lib/branding/metrics";
import {
  brandingRoutedTotal,
  brandingJevBreakerOpensTotal,
  brandingJevCallsTotal,
} from "../../../lib/branding/metrics";
import { mergeBrandingResults } from "../../../lib/branding/merge";
import { BrandingLLMInput } from "../../../lib/branding/types";
import { CostTracking } from "../../../lib/cost-tracking";
import { logger } from "../../../lib/logger";
import * as tracer from "../../../lib/otel-tracer";

const LOGO = {
  src: "https://acme.test/logo.svg",
  alt: "Acme",
  isSvg: true,
  isVisible: true,
  location: "header" as const,
  position: { top: 10, left: 10, width: 120, height: 32 },
  indicators: {
    inHeader: true,
    altMatch: true,
    srcMatch: true,
    classMatch: false,
    hrefMatch: true,
  },
  href: "/",
  source: "header a img",
};

const MENU_ICON = {
  ...LOGO,
  src: "https://acme.test/menu.svg",
  alt: "Open menu",
  position: { top: 10, left: 900, width: 20, height: 20 },
  indicators: { ...LOGO.indicators, altMatch: false, hrefMatch: false },
  href: undefined,
};

const baseInput = (costTracking: CostTracking): BrandingLLMInput => ({
  jsAnalysis: {
    colorScheme: "light",
    colors: {
      primary: "#6D28D9",
      background: "#FFFFFF",
      textPrimary: "#111111",
    },
    fonts: [
      { family: "__Inter_d65c78", count: 40 },
      { family: "__Inter_Fallback_d65c78", count: 40 },
      { family: "system-ui", count: 12 },
      { family: "Font Awesome 6 Free", count: 3 },
    ],
  },
  buttons: [
    {
      index: 0,
      text: "Get started",
      html: "",
      classes: "btn bg-violet-700 px-4",
      background: "#6D28D9",
      textColor: "#FFFFFF",
    },
    {
      index: 1,
      text: "Contact sales",
      html: "",
      classes: "btn border px-4",
      background: "transparent",
      textColor: "#111111",
      borderColor: "#111111",
    },
  ],
  logoCandidates: [MENU_ICON, LOGO],
  brandName: "Acme",
  pageTitle: "Acme | Home",
  url: "https://acme.test/",
  teamId: "team-jev",
  costTracking,
  logger,
});

// Colors in collection order: #6D28D9, #FFFFFF, #111111.
const jevResponse = (overrides: Record<string, unknown> = {}) => ({
  model: "jev-1.13.0",
  answers: {
    logo: {
      type: "choice",
      choice: "logo_1",
      probabilities: { logo_0: 0.04, logo_1: 0.95, none: 0.01 },
      confidence: 0.9,
    },
    primary_button: {
      type: "choice",
      choice: "button_0",
      probabilities: { button_0: 0.9, button_1: 0.1 },
      confidence: 0.85,
    },
    secondary_button: {
      type: "choice",
      choice: "button_1",
      probabilities: { button_0: 0.1, button_1: 0.85, none: 0.05 },
      confidence: 0.8,
    },
    primary_color: {
      type: "choice",
      choice: "color_0",
      probabilities: { color_0: 0.9, color_1: 0.05, color_2: 0.05 },
      confidence: 0.88,
    },
    accent_color: {
      type: "choice",
      choice: "color_0",
      probabilities: { color_0: 0.8, color_1: 0.1, color_2: 0.1 },
      confidence: 0.7,
    },
    secondary_color: {
      type: "choice",
      choice: "none",
      probabilities: { color_0: 0.1, color_1: 0.1, color_2: 0.1, none: 0.7 },
      confidence: 0.6,
    },
    background_color: {
      type: "choice",
      choice: "color_1",
      probabilities: { color_0: 0.02, color_1: 0.96, color_2: 0.02 },
      confidence: 0.94,
    },
    text_color: {
      type: "choice",
      choice: "color_2",
      probabilities: { color_0: 0.02, color_1: 0.03, color_2: 0.95 },
      confidence: 0.92,
    },
    font_0_is_brand: { type: "noul", noul: 0.97 },
    font_0_role: {
      type: "choice",
      choice: "body",
      probabilities: { body: 0.8, heading: 0.2 },
      confidence: 0.7,
    },
    font_1_is_brand: { type: "noul", noul: 0.08 },
    font_1_role: {
      type: "choice",
      choice: "unknown",
      probabilities: { unknown: 1 },
      confidence: 0.9,
    },
    tone: {
      type: "choice",
      choice: "modern",
      probabilities: { modern: 0.7 },
      confidence: 0.6,
    },
    energy: {
      type: "choice",
      choice: "medium",
      probabilities: { medium: 0.8 },
      confidence: 0.7,
    },
    audience: {
      type: "choice",
      choice: "businesses",
      probabilities: { businesses: 0.6 },
      confidence: 0.5,
    },
    framework: {
      type: "choice",
      choice: "tailwind",
      probabilities: { tailwind: 0.9 },
      confidence: 0.8,
    },
    component_library: {
      type: "choice",
      choice: "none",
      probabilities: { none: 0.9 },
      confidence: 0.8,
    },
    ...overrides,
  },
  usage: { input_tokens: 2000, output_tokens: 60 },
});

const saved = {
  key: config.TYPESAFE_API_KEY,
  global: config.BRANDING_JEV,
  screenshotPercent: config.BRANDING_JEV_SCREENSHOT_PERCENT,
};

beforeEach(() => {
  resetJevBreaker();
  config.TYPESAFE_API_KEY = "ts-test";
  config.BRANDING_JEV = undefined;
  mocks.systemOne.mockReset();
  (generateObject as Mock).mockReset().mockResolvedValue({
    object: {
      cleanedFonts: [],
      buttonClassification: {
        primaryButtonIndex: -1,
        primaryButtonReasoning: "none",
        secondaryButtonIndex: -1,
        secondaryButtonReasoning: "none",
        confidence: 0.5,
      },
      colorRoles: {
        primaryColor: "#000000",
        accentColor: "#000000",
        backgroundColor: "#FFFFFF",
        textPrimary: "#000000",
        confidence: 0.5,
      },
    },
    usage: { inputTokens: 6000, outputTokens: 400 },
  });
});

afterEach(() => {
  vi.useRealTimers();
  config.TYPESAFE_API_KEY = saved.key;
  config.BRANDING_JEV = saved.global;
  config.BRANDING_JEV_SCREENSHOT_PERCENT = saved.screenshotPercent;
});

const respondWith = (body: unknown) =>
  mocks.systemOne.mockResolvedValueOnce(body);

describe("branding with Jev", () => {
  it("answers branding from Jev and records its cost instead of an LLM call", async () => {
    respondWith(jevResponse());
    const costTracking = new CostTracking();

    const result = await enhanceBrandingWithLLM(baseInput(costTracking));

    expect(generateObject).not.toHaveBeenCalled();
    expect(result.logoSelection?.selectedLogoIndex).toBe(1);
    expect(result.logoSelection?.confidence).toBe(0.9);
    expect(result.buttonClassification.primaryButtonIndex).toBe(0);
    expect(result.buttonClassification.secondaryButtonIndex).toBe(1);
    expect(result.colorRoles).toMatchObject({
      primaryColor: "#6D28D9",
      accentColor: "#6D28D9",
      secondaryColor: "",
      backgroundColor: "#FFFFFF",
      textPrimary: "#111111",
    });
    expect(result.colorRoles.confidence).toBeCloseTo((0.88 + 0.94 + 0.92) / 3);
    expect(result.cleanedFonts).toEqual([{ family: "Inter", role: "body" }]);
    expect(result.personality).toEqual({
      tone: "modern",
      energy: "medium",
      targetAudience: "businesses",
    });
    expect(result.designSystem).toEqual({
      framework: "tailwind",
      componentLibrary: "",
    });

    expect(costTracking.calls).toHaveLength(1);
    expect(costTracking.calls[0]).toMatchObject({
      model: "jev-1.13.0",
      metadata: { module: "branding", method: "enhanceBrandingWithJev" },
      tokens: { input: 2000, output: 60 },
    });
    expect(costTracking.calls[0].cost).toBeCloseTo(
      (2000 * 0.042) / 1_000_000,
      12,
    );

    const [request, options] = mocks.systemOne.mock.calls[0];
    expect(request.model).toBe("jev-latest");
    expect(options).toEqual({
      timeout: 5000,
      retry: {
        maxRetries: 1,
        apiTimeoutError: true,
        backoffInitialMs: 100,
        httpStatuses: new Set([
          408,
          ...Array.from({ length: 100 }, (_, i) => 500 + i).filter(
            s => s !== 529,
          ),
        ]),
        maxRetryAfterMs: 1000,
      },
    });
    expect(Object.keys(request.questions.logo.criteria)).toEqual([
      "logo_0",
      "logo_1",
      "none",
    ]);
  });

  it("never returns the background as the text color or one button as both", async () => {
    respondWith(
      jevResponse({
        text_color: {
          type: "choice",
          choice: "color_1",
          probabilities: { color_0: 0.05, color_1: 0.6, color_2: 0.35 },
          confidence: 0.4,
        },
        secondary_button: {
          type: "choice",
          choice: "button_0",
          probabilities: { button_0: 0.7, button_1: 0.2, none: 0.1 },
          confidence: 0.5,
        },
      }),
    );

    const result = await enhanceBrandingWithLLM(baseInput(new CostTracking()));

    expect(result.colorRoles.backgroundColor).toBe("#FFFFFF");
    expect(result.colorRoles.textPrimary).toBe("#111111");
    expect(result.buttonClassification.primaryButtonIndex).toBe(0);
    expect(result.buttonClassification.secondaryButtonIndex).toBe(1);
  });

  it("keeps the heuristic value for a color role Jev is unsure of", async () => {
    const input = baseInput(new CostTracking());
    input.jsAnalysis.colors = { ...input.jsAnalysis.colors, accent: "#FF5500" };
    respondWith(
      jevResponse({
        accent_color: {
          type: "choice",
          choice: "color_2",
          probabilities: { color_0: 0.3, color_1: 0.3, color_2: 0.4 },
          confidence: 0.1,
        },
      }),
    );

    const result = await enhanceBrandingWithLLM(input);

    expect(result.colorRoles.accentColor).toBe("");
    expect(result.colorRoles.primaryColor).toBe("#6D28D9");
    const merged = mergeBrandingResults(
      input.jsAnalysis,
      result,
      input.buttons,
    );
    expect(merged.colors?.accent).toBe("#FF5500");
    expect(merged.colors?.primary).toBe("#6D28D9");
  });

  it("tells cookie settings apart from buttons that merely contain the words", () => {
    const input = baseInput(new CostTracking());
    input.buttons = [
      { ...input.buttons[0], index: 0, text: "View preferences" },
      { ...input.buttons[1], index: 1, text: "Preview settings" },
    ];
    expect(Object.keys(buildJevRequest(input).state.buttons as object)).toEqual(
      ["button_1"],
    );
  });

  it("never asks Jev to pick a cookie-consent button", async () => {
    const input = baseInput(new CostTracking());
    input.buttons = [
      { ...input.buttons[0], index: 0, text: "Accept all cookies" },
      { ...input.buttons[1], index: 1, text: "Reject all" },
      { ...input.buttons[0], index: 2, text: "Get started" },
    ];
    expect(Object.keys(buildJevRequest(input).state.buttons as object)).toEqual(
      ["button_2"],
    );

    input.buttons = input.buttons.slice(0, 2);
    const request = buildJevRequest(input);
    expect(request.questions.primary_button).toBeUndefined();
    respondWith(
      jevResponse({ primary_button: undefined, secondary_button: undefined }),
    );
    const result = await enhanceBrandingWithLLM(input);
    expect(result.buttonClassification.primaryButtonIndex).toBe(-1);
  });

  it("captures the first screen when the request asks, or for the rollout's teams", () => {
    config.BRANDING_JEV_SCREENSHOT_PERCENT = 0;
    expect(wantsBrandingScreenshot(true, "team-jev", false)).toBe("flag");
    expect(wantsBrandingScreenshot(undefined, "team-jev", false)).toBe(
      undefined,
    );

    config.BRANDING_JEV_SCREENSHOT_PERCENT = 100;
    expect(wantsBrandingScreenshot(undefined, "team-jev", false)).toBe(
      "rollout",
    );
    expect(wantsBrandingScreenshot(true, "team-jev", false)).toBe("flag");
    // an explicit false opts the request out of the rollout
    expect(wantsBrandingScreenshot(false, "team-jev", false)).toBe(undefined);
    expect(wantsBrandingScreenshot(undefined, undefined, false)).toBe(
      undefined,
    );
    // never for zero data retention
    expect(wantsBrandingScreenshot(true, "team-jev", true)).toBe(undefined);
    expect(wantsBrandingScreenshot(undefined, "team-jev", true)).toBe(
      undefined,
    );
  });

  describe("with the page's first screen", () => {
    // A 1x1 PNG padded to a real page's screenshot size: the guard drops
    // anything under 10 KB as a blank frame.
    const SHOT = Buffer.concat([
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        "base64",
      ),
      Buffer.alloc(30_000),
    ]);
    const PNG = SHOT.toString("base64");
    const screenshotCount = async (outcome: string) =>
      (await brandingJevScreenshotTotal.get()).values.find(
        v => v.labels.outcome === outcome,
      )?.value ?? 0;
    const sentWith = () => mocks.systemOne.mock.calls[0];

    afterEach(() => vi.unstubAllGlobals());

    it("attaches it as an image, opts in, and points the questions at it", async () => {
      mocks.systemOne.mockResolvedValueOnce(jevResponse());
      const input = baseInput(new CostTracking());
      input.firstScreen = `data:image/png;base64,${PNG}`;
      await enhanceBrandingWithLLM(input);

      const [request, options] = sentWith();
      expect(Object.keys(request.assets ?? {})).toEqual(["<screenshot>"]);
      expect(request.state.page.first_screen).toBe("<screenshot>");
      expect(request.questions.primary_button.instructions).toContain(
        "<screenshot>",
      );
      expect(options.headers).toEqual({
        "TypeSafe-Danger-Zone-Images": "true",
      });
    });

    it("downloads a screenshot fire-engine uploaded", async () => {
      const fetch = vi.fn(
        async () =>
          new Response(SHOT, {
            status: 200,
            headers: { "content-type": "image/jpeg" },
          }),
      );
      vi.stubGlobal("fetch", fetch);
      mocks.systemOne.mockResolvedValueOnce(jevResponse());
      const input = baseInput(new CostTracking());
      input.firstScreen = "https://storage.example/branding.jpg";
      await enhanceBrandingWithLLM(input);

      expect(fetch).toHaveBeenCalledWith(
        "https://storage.example/branding.jpg",
        expect.anything(),
      );
      expect(Object.keys(sentWith()[0].assets ?? {})).toEqual(["<screenshot>"]);
    });

    it("uses the download started when the engine returned instead of fetching again", async () => {
      const fetch = vi.fn(
        async () =>
          new Response(SHOT, {
            status: 200,
            headers: { "content-type": "image/jpeg" },
          }),
      );
      vi.stubGlobal("fetch", fetch);
      mocks.systemOne.mockResolvedValueOnce(jevResponse());
      const input = baseInput(new CostTracking());
      input.firstScreen = "https://storage.example/branding.jpg";
      input.firstScreenImage = loadFirstScreen(input.firstScreen, logger);
      await enhanceBrandingWithLLM(input);

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(Object.keys(sentWith()[0].assets ?? {})).toEqual(["<screenshot>"]);
    });

    it("resolves to nothing when the download fails, so an early start can't reject", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new Error("socket hang up");
        }),
      );
      await expect(
        loadFirstScreen("https://storage.example/branding.jpg", logger),
      ).resolves.toMatchObject({ outcome: "unreadable" });
    });

    it("skips a screenshot past the size cap without reading all of it", async () => {
      const big = new Response(new Uint8Array(9 * 1024 * 1024), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => big),
      );
      await expect(
        loadFirstScreen("https://storage.example/huge.jpg", logger),
      ).resolves.toMatchObject({ outcome: "too_large" });
      const inline = Buffer.alloc(9 * 1024 * 1024).toString("base64");
      await expect(
        loadFirstScreen(`data:image/jpeg;base64,${inline}`, logger),
      ).resolves.toMatchObject({ outcome: "too_large" });
    });

    it("answers without a blank frame and counts it", async () => {
      const blankBefore = await screenshotCount("blank");
      mocks.systemOne.mockResolvedValueOnce(jevResponse());
      const input = baseInput(new CostTracking());
      // a black 1280x720 JPEG is ~6 KB
      input.firstScreen = `data:image/jpeg;base64,${Buffer.alloc(6_000).toString("base64")}`;
      await enhanceBrandingWithLLM(input);

      expect(sentWith()[0].assets).toBeUndefined();
      expect(sentWith()[1].headers).toBeUndefined();
      expect(await screenshotCount("blank")).toBe(blankBefore + 1);
    });

    it("counts an attached screenshot, and none when there is no screenshot", async () => {
      const before = {
        attached: await screenshotCount("attached"),
        none: await screenshotCount("none"),
      };
      mocks.systemOne.mockResolvedValue(jevResponse());
      const withShot = baseInput(new CostTracking());
      withShot.firstScreen = `data:image/png;base64,${PNG}`;
      await enhanceBrandingWithLLM(withShot);
      await enhanceBrandingWithLLM(baseInput(new CostTracking()));

      expect(await screenshotCount("attached")).toBe(before.attached + 1);
      expect(await screenshotCount("none")).toBe(before.none + 1);
    });

    it("answers without it when the screenshot can't be read", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("gone", { status: 404 })),
      );
      mocks.systemOne.mockResolvedValueOnce(jevResponse());
      const input = baseInput(new CostTracking());
      input.firstScreen = "https://storage.example/missing.jpg";
      const result = await enhanceBrandingWithLLM(input);

      const [request, options] = sentWith();
      expect(request.assets).toBeUndefined();
      expect(request.state.page.first_screen).toBeUndefined();
      expect(options.headers).toBeUndefined();
      expect(
        result.buttonClassification.primaryButtonIndex,
      ).toBeGreaterThanOrEqual(0);
    });
  });

  it("fails fast when TypeSafe asks to back off, and retries a 503 or a timeout once, quickly", async () => {
    // The options Jev passes, run through the real SDK against a fake server.
    mocks.systemOne.mockResolvedValueOnce(jevResponse());
    await enhanceBrandingWithLLM(baseInput(new CostTracking()));
    const [request, options] = mocks.systemOne.mock.calls[0];
    const { TypeSafeClient } =
      await vi.importActual<typeof import("@typesafe-ai/sdk")>(
        "@typesafe-ai/sdk",
      );
    const call = async (status: number) => {
      const fetch = vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: "busy" } }), {
            status,
            headers: {
              "content-type": "application/json",
              "retry-after": "10",
            },
          }),
      );
      const client = new TypeSafeClient({
        apiKey: "test",
        logLevel: "off",
        fetch,
      });
      const started = Date.now();
      await expect(client.systemOne(request, options)).rejects.toThrow();
      return { attempts: fetch.mock.calls.length, ms: Date.now() - started };
    };

    for (const status of [529, 429]) {
      const r = await call(status);
      expect(r.attempts).toBe(1);
      expect(r.ms).toBeLessThan(500);
    }
    const r = await call(503);
    expect(r.attempts).toBe(2);
    expect(r.ms).toBeLessThan(2000); // not the 10 s Retry-After

    // A call that runs out of time is tried once more, right away.
    const fetch = vi.fn(async (_url: string, init?: RequestInit) =>
      fetch.mock.calls.length === 1
        ? new Promise<Response>((_, reject) =>
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            ),
          )
        : new Response(JSON.stringify(jevResponse()), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
    );
    const client = new TypeSafeClient({
      apiKey: "test",
      logLevel: "off",
      fetch,
    });
    const started = Date.now();
    await expect(
      client.systemOne(request, { ...options, timeout: 100 }),
    ).resolves.toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(Date.now() - started).toBeLessThan(400); // 100 ms timeout + ~0.1 s backoff
  });

  it("stops calling Jev for a minute after repeated failures, then tries again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-08T12:00:00Z"));
    mocks.systemOne.mockRejectedValue(new Error("529 high traffic"));

    for (let i = 0; i < 5; i++) {
      await enhanceBrandingWithLLM(baseInput(new CostTracking()));
    }
    expect(mocks.systemOne).toHaveBeenCalledTimes(5);

    // Open: answered by the LLM without waiting on Jev, and no first screen
    // is captured for a call that won't happen.
    await enhanceBrandingWithLLM(baseInput(new CostTracking()));
    expect(mocks.systemOne).toHaveBeenCalledTimes(5);
    expect(generateObject).toHaveBeenCalledTimes(6);
    config.BRANDING_JEV_SCREENSHOT_PERCENT = 100;
    expect(wantsBrandingScreenshot(true, "team-jev", false)).toBe(undefined);
    expect(wantsBrandingScreenshot(undefined, "team-jev", false)).toBe(
      undefined,
    );

    // After the cooldown Jev is tried again, and a success keeps it in use.
    vi.setSystemTime(Date.now() + 61_000);
    mocks.systemOne.mockReset().mockResolvedValue(jevResponse());
    await enhanceBrandingWithLLM(baseInput(new CostTracking()));
    await enhanceBrandingWithLLM(baseInput(new CostTracking()));
    expect(mocks.systemOne).toHaveBeenCalledTimes(2);
    expect(generateObject).toHaveBeenCalledTimes(6);
  });

  it("reopens on the first failure after the cooldown", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-08T12:00:00Z"));
    mocks.systemOne.mockRejectedValue(new Error("503 no healthy upstream"));
    for (let i = 0; i < 5; i++) {
      await enhanceBrandingWithLLM(baseInput(new CostTracking()));
    }

    vi.setSystemTime(Date.now() + 61_000);
    await enhanceBrandingWithLLM(baseInput(new CostTracking()));
    await enhanceBrandingWithLLM(baseInput(new CostTracking()));

    expect(mocks.systemOne).toHaveBeenCalledTimes(6);
  });

  it("reopens at once after the cooldown even if a call that started earlier succeeded late", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-08T12:00:00Z"));
    let finishSlowCall!: (value: unknown) => void;
    mocks.systemOne.mockImplementationOnce(
      () => new Promise(resolve => (finishSlowCall = resolve)),
    );
    const slow = enhanceBrandingWithLLM(baseInput(new CostTracking()));
    mocks.systemOne.mockRejectedValue(new Error("529 high traffic"));
    for (let i = 0; i < 5; i++) {
      await enhanceBrandingWithLLM(baseInput(new CostTracking()));
    }
    finishSlowCall(jevResponse());
    await slow;

    vi.setSystemTime(Date.now() + 61_000);
    await enhanceBrandingWithLLM(baseInput(new CostTracking()));
    await enhanceBrandingWithLLM(baseInput(new CostTracking()));

    // the slow call, five failures, one failure after the cooldown; then open again
    expect(mocks.systemOne).toHaveBeenCalledTimes(7);
  });

  it("does not count unusable answers as failures", async () => {
    mocks.systemOne.mockResolvedValue({
      model: "jev-1.13.0",
      usage: { input_tokens: 10, output_tokens: 0 },
    });

    for (let i = 0; i < 6; i++) {
      await enhanceBrandingWithLLM(baseInput(new CostTracking()));
    }

    expect(mocks.systemOne).toHaveBeenCalledTimes(6);
  });

  it("falls back to the LLM when Jev's answers have an unexpected shape", async () => {
    respondWith({
      model: "jev-1.13.0",
      usage: { input_tokens: 10, output_tokens: 0 },
    });
    const costTracking = new CostTracking();

    const result = await enhanceBrandingWithLLM(baseInput(costTracking));

    expect(generateObject).toHaveBeenCalledTimes(1);
    expect(result.colorRoles.primaryColor).toBe("#000000");
    expect(costTracking.calls.map(c => c.metadata.method)).toEqual([
      "enhanceBrandingWithJev",
      "enhanceBrandingWithLLM",
    ]);
  });

  it("drops fallback fonts and unplaced extras once headings and body are covered", async () => {
    const input = baseInput(new CostTracking());
    input.jsAnalysis.typography = {
      fontFamilies: { primary: "Inter", heading: "Inter" },
    };
    input.jsAnalysis.fonts = [
      { family: "Inter", count: 40 },
      { family: "Segoe UI", count: 20 },
      { family: "Roboto", count: 10 },
      { family: "Canela", count: 5 },
    ];
    respondWith(
      jevResponse({
        font_0_is_brand: { type: "noul", noul: 0.95 },
        font_1_is_brand: { type: "noul", noul: 0.9 },
        font_2_is_brand: { type: "noul", noul: 0.9 },
        font_3_is_brand: { type: "noul", noul: 0.9 },
        font_3_role: {
          type: "choice",
          choice: "unknown",
          probabilities: { unknown: 1 },
          confidence: 0.9,
        },
      }),
    );

    const result = await enhanceBrandingWithLLM(input);

    expect(result.cleanedFonts).toEqual([{ family: "Inter", role: "body" }]);
  });

  it("keeps the typography role of a family merged under its spaced name", async () => {
    const input = baseInput(new CostTracking());
    input.jsAnalysis.typography = {
      fontFamilies: { primary: "Inter", heading: "CormorantGaramond" },
    };
    input.jsAnalysis.fonts = [
      { family: "Inter", count: 40 },
      { family: "CormorantGaramond", count: 10 },
      { family: "Cormorant Garamond", count: 5 },
      { family: "Open-Sans", count: 3 },
      { family: "Open Sans", count: 2 },
    ];

    const request = buildJevRequest(input);

    expect(request.fonts.map(f => [f.family, f.role])).toEqual([
      ["Inter", "body"],
      ["Cormorant Garamond", "heading"],
      ["Open Sans", undefined],
    ]);
  });

  it("keeps a fallback font the page uses for text, or when it is all there is", async () => {
    const input = baseInput(new CostTracking());
    input.jsAnalysis.typography = { fontFamilies: { primary: "Arial" } };
    input.jsAnalysis.fonts = [{ family: "Arial", count: 40 }];
    respondWith(jevResponse({ font_0_is_brand: { type: "noul", noul: 0.9 } }));
    expect((await enhanceBrandingWithLLM(input)).cleanedFonts).toEqual([
      { family: "Arial", role: "body" },
    ]);

    const only = baseInput(new CostTracking());
    only.jsAnalysis.fonts = [{ family: "Helvetica", count: 40 }];
    respondWith(
      jevResponse({
        font_0_is_brand: { type: "noul", noul: 0.9 },
        font_0_role: {
          type: "choice",
          choice: "unknown",
          probabilities: { unknown: 1 },
          confidence: 0.9,
        },
      }),
    );
    expect((await enhanceBrandingWithLLM(only)).cleanedFonts).toEqual([
      { family: "Helvetica", role: "unknown" },
    ]);
  });

  it("takes font roles from the page's typography when it has them", async () => {
    const input = baseInput(new CostTracking());
    input.jsAnalysis.typography = {
      fontFamilies: { primary: "__Inter_d65c78", heading: "Söhne" },
    };
    input.jsAnalysis.fonts = [
      { family: "__Inter_d65c78", count: 40 },
      { family: "Söhne", count: 10 },
    ];

    const request = buildJevRequest(input);
    expect(request.questions.font_0_role).toBeUndefined();
    expect(request.questions.font_1_role).toBeUndefined();

    respondWith(jevResponse({ font_1_is_brand: { type: "noul", noul: 0.9 } }));
    const result = await enhanceBrandingWithLLM(input);
    expect(result.cleanedFonts).toEqual([
      { family: "Inter", role: "body" },
      { family: "Söhne", role: "heading" },
    ]);
  });

  it("reads the heading face from headings even when the first paragraph uses it", () => {
    const input = baseInput(new CostTracking());
    input.jsAnalysis.typography = {
      fontFamilies: { primary: "IBM Plex Sans", heading: "Libre Baskerville" },
      fontStacks: {
        body: ["IBM Plex Sans", "ui-sans-serif"],
        heading: ["Libre Baskerville", "Georgia"],
        paragraph: ["Libre Baskerville", "Georgia"],
      },
    };
    input.jsAnalysis.fonts = [
      { family: "IBM Plex Sans", count: 54 },
      { family: "Libre Baskerville", count: 26 },
      { family: "Lato", count: 10 },
    ];
    expect(buildJevRequest(input).fonts.map(f => [f.family, f.role])).toEqual([
      ["IBM Plex Sans", "body"],
      ["Libre Baskerville", "heading"],
      ["Lato", undefined],
    ]);

    // A paragraph font nothing else places is still body text.
    input.jsAnalysis.typography.fontStacks!.paragraph = ["Lato"];
    expect(buildJevRequest(input).fonts[2].role).toBe("body");
  });

  it("drops the browser's default font when a real face is the body text", async () => {
    const input = baseInput(new CostTracking());
    // The page styles inner elements, so <body> measures the default serif.
    input.jsAnalysis.typography = {
      fontFamilies: { primary: "Times New Roman" },
      fontStacks: { paragraph: ["Heebo", "sans-serif"] },
    };
    input.jsAnalysis.fonts = [
      { family: "Heebo", count: 200 },
      { family: "Times New Roman", count: 2 },
    ];
    respondWith(
      jevResponse({
        font_0_is_brand: { type: "noul", noul: 0.9 },
        font_1_is_brand: { type: "noul", noul: 0.6 },
      }),
    );

    expect((await enhanceBrandingWithLLM(input)).cleanedFonts).toEqual([
      { family: "Heebo", role: "body" },
    ]);
  });

  it("keeps the measured fonts when Jev rejects every one", async () => {
    const input = baseInput(new CostTracking());
    input.jsAnalysis.typography = {
      fontFamilies: { primary: "Times New Roman" },
    };
    input.jsAnalysis.fonts = [{ family: "Times New Roman", count: 5 }];
    respondWith(jevResponse({ font_0_is_brand: { type: "noul", noul: 0.4 } }));

    expect((await enhanceBrandingWithLLM(input)).cleanedFonts).toEqual([
      { family: "Times New Roman", role: "body" },
    ]);
  });

  it("shows Jev one button the scan reported twice, keeping the styled one", () => {
    const input = baseInput(new CostTracking());
    const cta = {
      ...input.buttons[0],
      text: "Book a demo",
      background: "#0D46DB",
      top: 459,
      left: 200,
      width: 140,
    };
    input.buttons = [
      // the link around the button: inherited text color, square corners
      { ...cta, index: 0, textColor: "#333333", borderRadius: "0px" },
      { ...cta, index: 1, textColor: "#FFFFFF", borderRadius: "6px", top: 461 },
      // the same label lower down the page is a different button
      {
        ...cta,
        index: 2,
        textColor: "#333333",
        borderRadius: "0px",
        top: 9000,
      },
      // and so is one beside it in the same row
      {
        ...cta,
        index: 3,
        textColor: "#333333",
        borderRadius: "0px",
        left: 360,
      },
    ];

    expect(Object.keys(buildJevRequest(input).state.buttons as object)).toEqual(
      ["button_1", "button_2", "button_3"],
    );
  });

  it("tells Jev the primary button is usually the brand-colored one", () => {
    const request = buildJevRequest(baseInput(new CostTracking()));
    expect(
      (request.questions.primary_button as { instructions: string })
        .instructions,
    ).toMatch(/brand's color/);
  });

  it("treats a pick between identical-looking buttons as confident", async () => {
    const input = baseInput(new CostTracking());
    input.buttons.push({
      ...input.buttons[0],
      index: 2,
      text: "Start free trial",
    });
    respondWith(
      jevResponse({
        primary_button: {
          type: "choice",
          choice: "button_0",
          // split between the two violet buttons
          probabilities: { button_0: 0.48, button_1: 0.04, button_2: 0.48 },
          confidence: 0.35,
        },
      }),
    );

    const result = await enhanceBrandingWithLLM(input);

    expect(result.buttonClassification.primaryButtonIndex).toBe(0);
    expect(result.buttonClassification.confidence).toBeCloseTo(0.96);
  });

  it("does not pool buttons that differ in shape", async () => {
    const input = baseInput(new CostTracking());
    input.buttons[0].borderRadius = "4px";
    input.buttons.push({
      ...input.buttons[0],
      index: 2,
      text: "Start free trial",
      borderRadius: "999px",
    });
    respondWith(
      jevResponse({
        primary_button: {
          type: "choice",
          choice: "button_0",
          probabilities: { button_0: 0.48, button_1: 0.04, button_2: 0.48 },
          confidence: 0.35,
        },
      }),
    );

    const result = await enhanceBrandingWithLLM(input);

    expect(result.buttonClassification.confidence).toBeCloseTo(0.48);
  });

  it("skips a secondary button that looks like the primary, since merge would drop it", async () => {
    const input = baseInput(new CostTracking());
    input.buttons.push({
      ...input.buttons[0],
      index: 2,
      text: "Start free trial",
    });
    respondWith(
      jevResponse({
        secondary_button: {
          type: "choice",
          choice: "button_2",
          probabilities: {
            button_0: 0.1,
            button_1: 0.3,
            button_2: 0.55,
            none: 0.05,
          },
          confidence: 0.5,
        },
      }),
    );

    const result = await enhanceBrandingWithLLM(input);

    expect(result.buttonClassification.secondaryButtonIndex).toBe(1);
    const merged = mergeBrandingResults(
      input.jsAnalysis,
      result,
      input.buttons,
    );
    expect(merged.components?.buttonSecondary?.background).toBe("transparent");
  });

  it("falls back to the LLM when the TypeSafe API errors", async () => {
    mocks.systemOne.mockRejectedValueOnce(new Error("invalid api key"));
    const costTracking = new CostTracking();

    const result = await enhanceBrandingWithLLM(baseInput(costTracking));

    expect(generateObject).toHaveBeenCalledTimes(1);
    expect(result.colorRoles.primaryColor).toBe("#000000");
    expect(costTracking.calls.map(c => c.metadata.method)).toEqual([
      "enhanceBrandingWithLLM",
    ]);
  });

  it("sends every team to Jev unless it's switched off", async () => {
    respondWith(jevResponse());
    await enhanceBrandingWithLLM({
      ...baseInput(new CostTracking()),
      teamId: "team-any",
    });
    expect(mocks.systemOne).toHaveBeenCalledTimes(1);
    expect(generateObject).not.toHaveBeenCalled();

    config.BRANDING_JEV = false;
    await enhanceBrandingWithLLM(baseInput(new CostTracking()));
    expect(mocks.systemOne).toHaveBeenCalledTimes(1);
    expect(generateObject).toHaveBeenCalledTimes(1);
  });

  it("uses Jev for zero-data-retention scrapes and keeps their span unexported", async () => {
    respondWith(jevResponse());
    const withSpan = vi.spyOn(tracer, "withSpan");

    const result = await enhanceBrandingWithLLM({
      ...baseInput(new CostTracking()),
      zeroDataRetention: true,
    });

    expect(mocks.systemOne).toHaveBeenCalledTimes(1);
    expect(generateObject).not.toHaveBeenCalled();
    expect(result.logoSelection?.selectedLogoIndex).toBe(1);
    expect(withSpan).toHaveBeenCalledWith(
      "typesafe.systemone",
      expect.any(Function),
      expect.objectContaining({ zeroDataRetention: true }),
    );
    withSpan.mockRestore();
  });

  it("tags the Jev span with the team so spend can be attributed", async () => {
    respondWith(jevResponse());
    const withSpan = vi.spyOn(tracer, "withSpan");

    await enhanceBrandingWithLLM(baseInput(new CostTracking()));

    const call = withSpan.mock.calls.find(c => c[0] === "typesafe.systemone");
    expect(call?.[2]?.attributes).toMatchObject({
      feature: "branding",
      teamId: "team-jev",
    });
    withSpan.mockRestore();
  });

  it("stays on the LLM when no TypeSafe key is configured", async () => {
    config.TYPESAFE_API_KEY = undefined;

    await enhanceBrandingWithLLM(baseInput(new CostTracking()));

    expect(mocks.systemOne).not.toHaveBeenCalled();
    expect(generateObject).toHaveBeenCalledTimes(1);
  });
});

describe("Jev request building", () => {
  it("describes colors by name and never sends hex values", () => {
    const request = buildJevRequest(baseInput(new CostTracking()));
    const state = JSON.stringify(request.state);

    expect(state).not.toMatch(/#[0-9a-f]{6}/i);
    expect(request.state.colors).toMatchObject({
      color_0: { looks: "vivid violet" },
      color_1: { looks: "white" },
      color_2: { looks: "near-black" },
    });
    expect(request.colors.map(c => c.hex)).toEqual([
      "#6D28D9",
      "#FFFFFF",
      "#111111",
    ]);
  });

  it("offers the likeliest logo's colors, labelled as the logo's", () => {
    const input = baseInput(new CostTracking());
    input.logoCandidates = [
      { ...MENU_ICON, colors: [{ color: "#FF0000", share: 1 }] },
      {
        ...LOGO,
        colors: [
          { color: "#0E7E4E", share: 0.7 },
          { color: "#6D28D9", share: 0.3 },
        ],
      },
    ];
    input.heuristicLogoPick = {
      selectedIndexInFilteredList: 1,
      confidence: 0.9,
      reasoning: "header home link",
    };

    const request = buildJevRequest(input);
    const usage = (hex: string) =>
      request.colors.find(c => c.hex === hex)?.usage ?? [];

    expect(usage("#0E7E4E")).toEqual(["color of the logo (70% of it)"]);
    // A color in both the logo and a button carries both.
    expect(usage("#6D28D9")).toEqual(
      expect.arrayContaining([
        "color of the logo (30% of it)",
        'background of button "Get started"',
      ]),
    );
    expect(request.colors.map(c => c.hex)).not.toContain("#FF0000");
  });

  it("sends only well-formed Unicode text", () => {
    // "𝐁" (U+1D401) is a surrogate pair. The branding script truncates button
    // text by code unit, which can leave its first half alone at the end.
    const bold = "\u{1D401}";
    const input = baseInput(new CostTracking());
    input.pageTitle = "a".repeat(199) + bold;
    input.buttons![0].text = "Beyond the Storefront " + bold + "\uD835";
    input.buttons![1].text = "x".repeat(39) + bold;

    const request = buildJevRequest(input);
    const page = request.state.page as Record<string, string>;
    const buttons = request.state.buttons as Record<
      string,
      Record<string, string>
    >;

    // clip() drops a pair it would cut in half rather than keep one half.
    expect(page.title).toBe("a".repeat(199));
    expect(buttons.button_0.text).toBe(
      "Beyond the Storefront " + bold + "\uFFFD",
    );
    // JSON.stringify escapes lone surrogates as \udxxx; none may remain.
    expect(JSON.stringify(request.state)).not.toMatch(/\\ud[89a-f]/i);
  });

  it("names common colors", () => {
    expect(describeColor("#E2511A")).toBe("vivid orange");
    expect(describeColor("#0A2540")).toBe("very dark blue");
    expect(describeColor("#F6F9FC")).toBe("near-white");
    expect(describeColor("#1A73E8")).toBe("vivid blue");
  });

  it("cleans font names in code", () => {
    expect(cleanFontFamily("__Roboto_Mono_c8ca7d")).toBe("Roboto Mono");
    expect(cleanFontFamily("__suisse_6d5c28")).toBe("Suisse");
    expect(cleanFontFamily("__suisse_Fallback_6d5c28")).toBeUndefined();
    expect(cleanFontFamily("var(--font-sans)")).toBeUndefined();
    expect(cleanFontFamily("'Söhne'")).toBe("Söhne");
    expect(cleanFontFamily("ui-sans-serif")).toBeUndefined();
    expect(cleanFontFamily("system-ui, sans-serif")).toBeUndefined();
    expect(cleanFontFamily("Inter, sans-serif")).toBe("Inter");
    expect(cleanFontFamily("Newsreader Variable")).toBe("Newsreader");
  });

  it("drops the weight from self-hosted font names and spaces run-together ones", () => {
    expect(cleanFontFamily("OpenSans--Regular")).toBe("Open Sans");
    expect(cleanFontFamily("Verdana-Regular")).toBe("Verdana");
    expect(cleanFontFamily("Inter Bold")).toBe("Inter");
    expect(cleanFontFamily("GmarketSansMedium")).toBe("Gmarket Sans");
    expect(cleanFontFamily("GlacialIndifference")).toBe("Glacial Indifference");
    expect(cleanFontFamily("Playfair Display Italic")).toBe("Playfair Display");
    // A weight alone is not a family; names that only contain one stay.
    expect(cleanFontFamily("Regular")).toBeUndefined();
    expect(cleanFontFamily("Bold Italic")).toBeUndefined();
    expect(cleanFontFamily("Times New Roman")).toBe("Times New Roman");
    expect(cleanFontFamily("Black Han Sans")).toBe("Black Han Sans");
    expect(cleanFontFamily("Book Antiqua")).toBe("Book Antiqua");
    // Families that end in a heavy weight keep it; a self-hosted face doesn't.
    expect(cleanFontFamily("Cooper Black")).toBe("Cooper Black");
    expect(cleanFontFamily("Arial Black")).toBe("Arial Black");
    expect(cleanFontFamily("Roboto-Black")).toBe("Roboto");
    expect(cleanFontFamily("Roboto_Black")).toBe("Roboto");
    expect(cleanFontFamily("__Roboto_Mono_Book_c8ca7d")).toBe("Roboto Mono");
    // Acronyms aren't split.
    expect(cleanFontFamily("TIActuBeta")).toBe("TIActuBeta");
    expect(cleanFontFamily("HardwoodLP")).toBe("HardwoodLP");
  });

  it("merges a family listed with and without spaces", () => {
    const input = baseInput(new CostTracking());
    input.jsAnalysis.fonts = [
      { family: "CormorantGaramond", count: 10 },
      { family: "Cormorant Garamond", count: 5 },
    ];
    expect(buildJevRequest(input).fonts).toEqual([
      { family: "Cormorant Garamond", count: 15, role: undefined },
    ]);
  });

  it("merges hyphen and underscore spellings of one family", () => {
    const input = baseInput(new CostTracking());
    input.jsAnalysis.typography = { fontFamilies: { primary: "Adobe-Clean" } };
    input.jsAnalysis.fonts = [
      { family: "Adobe-Clean", count: 12 },
      { family: "Adobe Clean", count: 8 },
      { family: "Adobe_Clean", count: 1 },
    ];
    expect(buildJevRequest(input).fonts).toEqual([
      { family: "Adobe Clean", count: 21, role: "body" },
    ]);
  });
});

describe("branding metrics", () => {
  const value = async (
    metric: {
      get: () => Promise<{ values: { labels: object; value: number }[] }>;
    },
    labels: Record<string, string> = {},
  ) =>
    (await metric.get()).values.find(v =>
      Object.entries(labels).every(
        ([k, want]) => (v.labels as Record<string, string>)[k] === want,
      ),
    )?.value ?? 0;

  it("counts which model answered and how each Jev call ended", async () => {
    const jevOk = { outcome: "ok" };
    const rateLimited = { outcome: "rate_limited" };
    const timedOut = { outcome: "timeout" };
    const byJev = { model: "jev", reason: "jev" };
    const fellBack = { model: "llm", reason: "jev_unavailable" };
    const before = {
      jevOk: await value(brandingJevCallsTotal, jevOk),
      rateLimited: await value(brandingJevCallsTotal, rateLimited),
      timedOut: await value(brandingJevCallsTotal, timedOut),
      byJev: await value(brandingRoutedTotal, byJev),
      fellBack: await value(brandingRoutedTotal, fellBack),
    };

    respondWith(jevResponse());
    await enhanceBrandingWithLLM(baseInput(new CostTracking()));
    mocks.systemOne.mockRejectedValueOnce(
      new RateLimitError(429, {}, new Headers()),
    );
    await enhanceBrandingWithLLM(baseInput(new CostTracking()));
    mocks.systemOne.mockRejectedValueOnce(new APITimeoutError(1500));
    await enhanceBrandingWithLLM(baseInput(new CostTracking()));

    expect(await value(brandingJevCallsTotal, jevOk)).toBe(before.jevOk + 1);
    expect(await value(brandingJevCallsTotal, rateLimited)).toBe(
      before.rateLimited + 1,
    );
    expect(await value(brandingJevCallsTotal, timedOut)).toBe(
      before.timedOut + 1,
    );
    expect(await value(brandingRoutedTotal, byJev)).toBe(before.byJev + 1);
    expect(await value(brandingRoutedTotal, fellBack)).toBe(
      before.fellBack + 2,
    );
  });

  it("counts the breaker opening and the calls it skips", async () => {
    const skipped = { outcome: "breaker_open" };
    const opensBefore = await value(brandingJevBreakerOpensTotal);
    const skippedBefore = await value(brandingJevCallsTotal, skipped);
    mocks.systemOne.mockRejectedValue(new Error("529 high traffic"));

    for (let i = 0; i < 6; i++) {
      await enhanceBrandingWithLLM(baseInput(new CostTracking()));
    }

    expect(await value(brandingJevBreakerOpensTotal)).toBe(opensBefore + 1);
    expect(await value(brandingJevCallsTotal, skipped)).toBe(skippedBefore + 1);
  });

  it("counts branding sent to the LLM while Jev is switched off", async () => {
    const outside = { model: "llm", reason: "jev_off" };
    const before = await value(brandingRoutedTotal, outside);
    config.BRANDING_JEV = false;

    await enhanceBrandingWithLLM(baseInput(new CostTracking()));

    expect(await value(brandingRoutedTotal, outside)).toBe(before + 1);
    expect(mocks.systemOne).not.toHaveBeenCalled();
  });

  it("counts branding without a TypeSafe key apart from the switch", async () => {
    const noKey = { model: "llm", reason: "jev_no_key" };
    const off = { model: "llm", reason: "jev_off" };
    const [noKeyBefore, offBefore] = [
      await value(brandingRoutedTotal, noKey),
      await value(brandingRoutedTotal, off),
    ];
    config.TYPESAFE_API_KEY = undefined;

    await enhanceBrandingWithLLM(baseInput(new CostTracking()));

    expect(await value(brandingRoutedTotal, noKey)).toBe(noKeyBefore + 1);
    expect(await value(brandingRoutedTotal, off)).toBe(offBefore);
    expect(mocks.systemOne).not.toHaveBeenCalled();
  });
});

describe("logo candidates as Jev sees them", () => {
  const candidates = (input: BrandingLLMInput) =>
    buildJevRequest(input).state.logo_candidates as Record<
      string,
      Record<string, unknown>
    >;

  it("names a link's path instead of trusting the scan's homepage flag", () => {
    const input = baseInput(new CostTracking());
    input.pageUrl = "https://acme.test/";
    input.logoCandidates = [
      LOGO,
      { ...LOGO, src: "https://acme.test/home.svg", alt: "home", href: "/home/" },
      { ...LOGO, src: "https://acme.test/cart.svg", alt: "", href: "/cart" },
      { ...LOGO, src: "https://acme.test/www.svg", href: "https://www.acme.test/?ref=nav" },
      { ...LOGO, src: "https://acme.test/x.svg", href: "https://x.com/acme" },
      { ...LOGO, src: "https://acme.test/nolink.svg", href: undefined },
      // The scan resolved these as the home link; we can't tell from the href.
      { ...LOGO, src: "https://acme.test/sibling.svg", href: "https://acme.io/" },
      { ...LOGO, src: "https://acme.test/js.svg", href: "javascript:void(0)" },
      { ...LOGO, src: "https://acme.test/mail.svg", href: "mailto:hi@acme.test", indicators: { ...LOGO.indicators, hrefMatch: false } },
      { ...LOGO, src: "https://acme.test/other.svg", href: "https://acme.io/pricing", indicators: { ...LOGO.indicators, hrefMatch: false } },
    ];
    expect(Object.values(candidates(input)).map(c => c.link)).toEqual([
      "links to the homepage",
      "links to /home on this site",
      "links to /cart on this site",
      "links to the homepage",
      "links to another website (x.com)",
      "no link",
      "links to the homepage",
      "links to the homepage",
      "mailto: link",
      "links to another website (acme.io)",
    ]);
  });

  it("shows a declared mark as metadata, not as a rendered header logo", () => {
    const input = baseInput(new CostTracking());
    input.logoCandidates = [
      LOGO,
      {
        ...LOGO,
        src: "https://acme.test/apple-touch-icon.png",
        isSvg: false,
        position: { top: 0, left: 0, width: 180, height: 180 },
        href: undefined,
        source: "apple-touch-icon",
      },
    ];
    const [rendered, declared] = Object.values(candidates(input));
    expect(rendered).toMatchObject({
      where: "header",
      visible: true,
      link: "links to the homepage",
    });
    expect(declared).toMatchObject({
      where: "page metadata, not rendered",
      visible: false,
      size: "unknown",
      shape: "unknown",
      link: "no link",
      found_via: "apple-touch-icon",
    });
  });
});

