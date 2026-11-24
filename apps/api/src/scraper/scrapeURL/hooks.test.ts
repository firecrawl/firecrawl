import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Engine as RegisteredEngine } from "../../service/engines";
import type { ScrapeFinished } from "../../service/hooks";
import type { Extension } from "../../service/service";
import { createService, replaceService } from "../../service/service";
import { scrapeOptions } from "../../controllers/v2/types";
import { CostTracking } from "../../lib/cost-tracking";
import { ScrapeJobTimeoutError } from "../../lib/error";
import { requestContext } from "../../lib/request-context";

vi.mock("../../services/index", () => ({
  useIndex: false,
  useSearchIndex: false,
}));

vi.mock("../WebScraper/utils/blocklist", () => ({
  isUrlBlocked: vi.fn(() => false),
}));

vi.mock("../../lib/exchange", () => ({
  getExchangeAccessForRequest: vi.fn(async () => ({ allowed: false })),
  ThirdPartyDataTermsRequiredError: class extends Error {},
  ThirdPartyDataUnsupportedOptionError: class extends Error {},
}));

vi.mock("./lib/removeUnwantedElements", async importOriginal => {
  const actual =
    await importOriginal<typeof import("./lib/removeUnwantedElements")>();
  return {
    ...actual,
    htmlTransform: vi.fn(actual.htmlTransform),
  };
});

import { scrapeURL } from ".";
import { coreEngineFeatures, type EngineScrapeResult } from "./engines";
import { EngineError, NoEnginesLeftError } from "./error";
import { createScrapeFinishedEmitter } from "./hooks";
import { AbortManager, AbortManagerThrownError } from "./lib/abortManager";
import { htmlTransform } from "./lib/removeUnwantedElements";
import { executeTransformers } from "./transformers";

const makeEngine = (
  name: string,
  scrape: RegisteredEngine["scrape"],
  options: {
    quality?: number;
    features?: Record<string, boolean>;
    enabled?: () => boolean;
  } = {},
): RegisteredEngine =>
  ({
    name,
    quality: options.quality ?? 10,
    features: options.features ?? {},
    enabled: options.enabled ?? (() => true),
    maxReasonableTime: () => 5_000,
    scrape,
  }) as unknown as RegisteredEngine;

const installTestService = (
  engines: readonly RegisteredEngine[],
  extensions: Extension[] = [],
) => {
  replaceService(
    createService(
      { modules: {}, extensions },
      {
        core: {
          name: "core",
          engines,
          engineFeatures: coreEngineFeatures,
        },
        logger: { error: vi.fn() },
      },
    ),
  );
};

beforeEach(() => {
  vi.mocked(htmlTransform).mockClear();
});

afterEach(() => {
  replaceService(undefined);
});

describe("scrape pipeline hook points", () => {
  it("runs all 10 scrape hooks in order with shared ScrapeState", async () => {
    const fetchScrape = vi.fn(async (): Promise<EngineScrapeResult> => {
      throw new EngineError("fetch failed");
    });
    const playwrightScrape = vi.fn(
      async (): Promise<EngineScrapeResult> => ({
        url: "https://example.com/page",
        html: "<html><head><title>Initial</title></head><body><h1>Hello</h1></body></html>",
        statusCode: 200,
        proxyUsed: "basic",
      }),
    );

    const pushTrace = (state: Record<string, unknown>, label: string) => {
      const trace = (state.trace as string[] | undefined) ?? [];
      trace.push(label);
      state.trace = trace;
    };

    const finishedEvents: ScrapeFinished[] = [];

    installTestService(
      [
        makeEngine("fetch", fetchScrape, { quality: 20 }),
        makeEngine("playwright", playwrightScrape, { quality: 10 }),
      ],
      [
        {
          name: "test-hooks",
          hooks: {
            "scrape.start": (plan, meta) => {
              pushTrace(meta.state as Record<string, unknown>, "scrape.start");
              expect(meta.ctx.teamId).toBe("team-hooks");
              return {
                ...plan,
                options: { ...plan.options, onlyMainContent: false },
              };
            },
            "scrape.engines.select": (plan, meta) => {
              pushTrace(
                meta.state as Record<string, unknown>,
                "scrape.engines.select",
              );
              expect(plan.candidates).toContain("fetch");
              return { candidates: ["fetch"] };
            },
            "scrape.engine.fallback": (_plan, info) => {
              pushTrace(
                info.state as Record<string, unknown>,
                "scrape.engine.fallback",
              );
              expect(info.failed).toBe("fetch");
              expect(info.error).toBeInstanceOf(EngineError);
              return { candidates: ["playwright"] };
            },
            "scrape.fetched": (result, meta) => {
              pushTrace(
                meta.state as Record<string, unknown>,
                "scrape.fetched",
              );
              return {
                ...result,
                html: result.html.replace("Hello", "FromFetchedHook"),
              };
            },
            "scrape.html.clean": (cleaning, meta) => {
              pushTrace(
                meta.state as Record<string, unknown>,
                "scrape.html.clean",
              );
              expect(cleaning.url).toBe("https://example.com/page");
              expect(cleaning.onlyMainContent).toBe(false);
              return {
                ...cleaning,
                dropSignatures: ["sig-nav"],
              };
            },
            "scrape.document.markdown": (doc, meta) => {
              pushTrace(
                meta.state as Record<string, unknown>,
                "scrape.document.markdown",
              );
              return {
                ...doc,
                markdown: `${doc.markdown ?? ""}\n<!-- md-hook -->`,
              };
            },
            "scrape.document.derived": (doc, meta) => {
              pushTrace(
                meta.state as Record<string, unknown>,
                "scrape.document.derived",
              );
              return {
                ...doc,
                metadata: { ...doc.metadata, title: "Derived Title" },
              };
            },
            "scrape.document.extracted": (doc, meta) => {
              pushTrace(
                meta.state as Record<string, unknown>,
                "scrape.document.extracted",
              );
              return doc;
            },
            "scrape.document.final": (doc, meta) => {
              pushTrace(
                meta.state as Record<string, unknown>,
                "scrape.document.final",
              );
              return {
                ...doc,
                warning: "final-hook-note",
              };
            },
            "scrape.finished": async event => {
              pushTrace(
                event.state as Record<string, unknown>,
                "scrape.finished",
              );
              finishedEvents.push(event);
            },
          },
        },
      ],
    );

    const parsedOptions = scrapeOptions.parse({
      formats: ["markdown", "html"],
    });
    const ctx = requestContext({
      teamId: "team-hooks",
      zeroDataRetention: false,
      orgId: null,
    });

    const result = await scrapeURL(
      "scrape-hooks-e2e",
      "https://example.com/page",
      parsedOptions,
      { teamId: "team-hooks", orgId: null, ctx },
      new CostTracking(),
    );

    expect(result.success).toBe(true);
    if (!result.success) return;

    const emitFinished = createScrapeFinishedEmitter({
      jobId: "scrape-hooks-e2e",
      requestId: "req-1",
      kind: "scrape",
      ctx,
      url: "https://example.com/page",
      options: parsedOptions,
      getState: () => result.state,
    });
    await emitFinished({
      document: result.document,
      charged: 1,
      timeTakenMs: 42,
    });

    expect(fetchScrape).toHaveBeenCalledTimes(1);
    expect(playwrightScrape).toHaveBeenCalledTimes(1);
    expect(result.document.markdown).toContain("FromFetchedHook");
    expect(result.document.markdown).toContain("<!-- md-hook -->");
    expect(result.document.metadata.title).toBe("Derived Title");
    expect(result.document.warning).toBe("final-hook-note");
    expect(finishedEvents).toHaveLength(1);
    expect(finishedEvents[0]).toMatchObject({
      jobId: "scrape-hooks-e2e",
      requestId: "req-1",
      kind: "scrape",
      ctx,
      url: "https://example.com/page",
      charged: 1,
      timeTakenMs: 42,
    });
    expect(finishedEvents[0].state).toBe(result.state);
    expect((result.state as Record<string, unknown>)?.trace).toEqual([
      "scrape.start",
      "scrape.engines.select",
      "scrape.engine.fallback",
      "scrape.fetched",
      "scrape.html.clean",
      "scrape.document.markdown",
      "scrape.document.derived",
      "scrape.document.extracted",
      "scrape.document.final",
      "scrape.finished",
    ]);

    const cleanCall = vi
      .mocked(htmlTransform)
      .mock.calls.find(call => call[3] !== undefined);
    expect(cleanCall?.[3]).toEqual(["sig-nav"]);
  });

  it("lets scrape.start add engine features that steer engine selection", async () => {
    const fetchScrape = vi.fn(
      async (): Promise<EngineScrapeResult> => ({
        url: "https://example.com/basic",
        html: "<html><body><p>From fetch</p></body></html>",
        statusCode: 200,
        proxyUsed: "basic",
      }),
    );
    const playwrightScrape = vi.fn(
      async (): Promise<EngineScrapeResult> => ({
        url: "https://example.com/wait",
        html: "<html><body><p>From playwright</p></body></html>",
        statusCode: 200,
        proxyUsed: "basic",
      }),
    );

    installTestService(
      [
        makeEngine("fetch", fetchScrape, {
          quality: 20,
          features: { waitFor: false },
        }),
        makeEngine("playwright", playwrightScrape, {
          quality: 10,
          features: { waitFor: true },
        }),
      ],
      [
        {
          name: "feature-hook",
          hooks: {
            "scrape.start": plan => {
              plan.features.add("waitFor");
              return plan;
            },
          },
        },
      ],
    );

    const result = await scrapeURL(
      "scrape-feature-add",
      "https://example.com/wait",
      scrapeOptions.parse({ formats: ["markdown"] }),
      { teamId: "team-feature", orgId: null },
      new CostTracking(),
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(playwrightScrape).toHaveBeenCalledTimes(1);
    expect(fetchScrape).not.toHaveBeenCalled();
    expect(result.document.markdown).toContain("From playwright");
  });

  it("skips unregistered, disabled, and duplicate engines from scrape.engines.select", async () => {
    const disabledScrape = vi.fn();
    const playwrightScrape = vi.fn(async (): Promise<EngineScrapeResult> => {
      throw new EngineError("playwright failed");
    });

    installTestService(
      [
        makeEngine("fetch", disabledScrape, {
          quality: 20,
          enabled: () => false,
        }),
        makeEngine("playwright", playwrightScrape, { quality: 10 }),
      ],
      [
        {
          name: "select-hook",
          hooks: {
            "scrape.engines.select": () => ({
              candidates: ["pdf", "fetch", "playwright", "playwright"],
            }),
          },
        },
      ],
    );

    const result = await scrapeURL(
      "scrape-select-skip",
      "https://example.com/reordered",
      scrapeOptions.parse({ formats: ["markdown"] }),
      { teamId: "team-select", orgId: null },
      new CostTracking(),
    );

    expect(result.success).toBe(false);
    expect(disabledScrape).not.toHaveBeenCalled();
    expect(playwrightScrape).toHaveBeenCalledTimes(1);
  });

  it("prevents scrape.engine.fallback from re-queuing attempted engines and tracks added engines", async () => {
    const fetchScrape = vi.fn(async (): Promise<EngineScrapeResult> => {
      throw new EngineError("fetch failed");
    });
    const playwrightScrape = vi.fn(async (): Promise<EngineScrapeResult> => {
      throw new EngineError("playwright failed");
    });

    installTestService(
      [
        makeEngine("fetch", fetchScrape, { quality: 20 }),
        makeEngine("playwright", playwrightScrape, { quality: 10 }),
      ],
      [
        {
          name: "static-fallback-hook",
          hooks: {
            "scrape.engines.select": () => ({ candidates: ["fetch"] }),
            // Returns a static list including the already-failed engine.
            "scrape.engine.fallback": () => ({
              candidates: ["fetch", "playwright"],
            }),
          },
        },
      ],
    );

    const result = await scrapeURL(
      "scrape-fallback-dedup",
      "https://example.com/fallback",
      scrapeOptions.parse({ formats: ["markdown"] }),
      { teamId: "team-fallback", orgId: null },
      new CostTracking(),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(fetchScrape).toHaveBeenCalledTimes(1);
    expect(playwrightScrape).toHaveBeenCalledTimes(1);
    expect(result.error).toBeInstanceOf(NoEnginesLeftError);
    expect((result.error as NoEnginesLeftError).fallbackList).toEqual([
      "fetch",
      "playwright",
    ]);
  });

  it("preserves skipTlsVerification=false for zero data retention scrapes after scrape.start", async () => {
    let observedSkipTls: boolean | undefined;
    const fetchScrape = vi.fn(
      async (meta: { options: { skipTlsVerification: boolean } }) => {
        observedSkipTls = meta.options.skipTlsVerification;
        return {
          url: "https://example.com/zdr",
          html: "<html><body><p>ZDR</p></body></html>",
          statusCode: 200,
          proxyUsed: "basic" as const,
        };
      },
    );

    installTestService(
      [makeEngine("fetch", fetchScrape, { quality: 20 })],
      [
        {
          name: "zdr-tls-hook",
          hooks: {
            "scrape.start": plan => ({
              ...plan,
              options: { ...plan.options, skipTlsVerification: true },
            }),
          },
        },
      ],
    );

    const result = await scrapeURL(
      "scrape-zdr-tls",
      "https://example.com/zdr",
      scrapeOptions.parse({
        formats: ["markdown"],
        skipTlsVerification: true,
      }),
      { teamId: "team-zdr", orgId: null, zeroDataRetention: true },
      new CostTracking(),
    );

    expect(result.success).toBe(true);
    expect(observedSkipTls).toBe(false);
  });

  it("produces deterministic output with an empty hooks registry", async () => {
    const html =
      "<html><head><title>Baseline</title></head><body><h1>Hello World</h1></body></html>";
    const scrape = vi.fn(
      async (): Promise<EngineScrapeResult> => ({
        url: "https://example.com/baseline",
        html,
        statusCode: 200,
        proxyUsed: "basic",
      }),
    );

    installTestService([makeEngine("fetch", scrape, { quality: 20 })]);

    const first = await scrapeURL(
      "scrape-baseline",
      "https://example.com/baseline",
      scrapeOptions.parse({ formats: ["markdown", "html"] }),
      { teamId: "team-baseline", orgId: null },
      new CostTracking(),
    );

    installTestService(
      [makeEngine("fetch", scrape, { quality: 20 })],
      [{ name: "empty-extension", hooks: {} }],
    );

    const second = await scrapeURL(
      "scrape-baseline",
      "https://example.com/baseline",
      scrapeOptions.parse({ formats: ["markdown", "html"] }),
      { teamId: "team-baseline", orgId: null },
      new CostTracking(),
    );

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (!first.success || !second.success) return;
    expect(first.document.markdown).toContain("Hello World");
    expect(first.document.html).toContain("<h1>Hello World</h1>");
    expect(first.document.metadata.title).toBe("Baseline");
    expect(first.document.metadata.statusCode).toBe(200);
    expect(first.document.metadata.scrapeId).toBe("scrape-baseline");
    expect(second.document).toEqual(first.document);
    expect(first.state).toEqual({});
    expect(second.state).toEqual({});
  });

  it("enforces ZDR and profile engine safety policies on scrape.engines.select", async () => {
    const wikiScrape = vi.fn(
      async (): Promise<EngineScrapeResult> => ({
        url: "https://en.wikipedia.org/wiki/Test",
        html: "<html><body><p>Wiki</p></body></html>",
        statusCode: 200,
        proxyUsed: "basic",
      }),
    );
    const fetchScrape = vi.fn(
      async (): Promise<EngineScrapeResult> => ({
        url: "https://en.wikipedia.org/wiki/Test",
        html: "<html><body><p>Direct</p></body></html>",
        statusCode: 200,
        proxyUsed: "basic",
      }),
    );
    const cdpScrape = vi.fn(
      async (): Promise<EngineScrapeResult> => ({
        url: "https://example.com/profile",
        html: "<html><body><p>Authenticated</p></body></html>",
        statusCode: 200,
        proxyUsed: "basic",
      }),
    );

    installTestService(
      [
        makeEngine("wikipedia", wikiScrape, { quality: 50 }),
        makeEngine("fetch", fetchScrape, { quality: 20 }),
        makeEngine("fire-engine;chrome-cdp", cdpScrape, { quality: 30 }),
      ],
      [
        {
          name: "unsafe-select-hook",
          hooks: {
            "scrape.engines.select": () => ({
              candidates: ["wikipedia", "fetch", "fire-engine;chrome-cdp"],
            }),
          },
        },
      ],
    );

    const zdrResult = await scrapeURL(
      "scrape-zdr-policy",
      "https://en.wikipedia.org/wiki/Test",
      scrapeOptions.parse({ formats: ["markdown"] }),
      { teamId: "team-zdr", orgId: null, zeroDataRetention: true },
      new CostTracking(),
    );

    expect(zdrResult.success).toBe(true);
    expect(wikiScrape).not.toHaveBeenCalled();
    expect(fetchScrape).toHaveBeenCalledTimes(1);

    fetchScrape.mockClear();
    const profileResult = await scrapeURL(
      "scrape-profile-policy",
      "https://example.com/profile",
      scrapeOptions.parse({
        formats: ["markdown"],
        profile: { name: "user-profile", saveChanges: false },
      }),
      { teamId: "team-profile", orgId: null },
      new CostTracking(),
    );

    expect(profileResult.success).toBe(true);
    expect(wikiScrape).not.toHaveBeenCalled();
    expect(fetchScrape).not.toHaveBeenCalled();
    expect(cdpScrape).toHaveBeenCalledTimes(1);
  });

  it("rebuilds meta.abort when scrape.start updates options.timeout", async () => {
    let observedTimeout: number | undefined;
    const fetchScrape = vi.fn(
      async (meta: { abort: { scrapeTimeout: () => number | undefined } }) => {
        observedTimeout = meta.abort.scrapeTimeout();
        return {
          url: "https://example.com/timeout",
          html: "<html><body><p>OK</p></body></html>",
          statusCode: 200,
          proxyUsed: "basic" as const,
        };
      },
    );

    installTestService(
      [makeEngine("fetch", fetchScrape, { quality: 20 })],
      [
        {
          name: "shorten-timeout-hook",
          hooks: {
            "scrape.start": plan => ({
              ...plan,
              options: { ...plan.options, timeout: 2_500 },
            }),
          },
        },
      ],
    );

    const shortened = await scrapeURL(
      "scrape-timeout-shortened",
      "https://example.com/timeout",
      scrapeOptions.parse({ formats: ["markdown"], timeout: 60_000 }),
      { teamId: "team-timeout", orgId: null },
      new CostTracking(),
    );

    expect(shortened.success).toBe(true);
    expect(observedTimeout).toBeDefined();
    expect(observedTimeout!).toBeGreaterThan(0);
    expect(observedTimeout!).toBeLessThanOrEqual(2_500);

    installTestService(
      [makeEngine("fetch", fetchScrape, { quality: 20 })],
      [
        {
          name: "zero-timeout-hook",
          hooks: {
            "scrape.start": plan => ({
              ...plan,
              options: { ...plan.options, timeout: 0 },
            }),
          },
        },
      ],
    );

    await expect(
      scrapeURL(
        "scrape-timeout-expired",
        "https://example.com/timeout",
        scrapeOptions.parse({ formats: ["markdown"], timeout: 60_000 }),
        { teamId: "team-timeout", orgId: null },
        new CostTracking(),
      ),
    ).rejects.toBeInstanceOf(ScrapeJobTimeoutError);

    const expiredController = new AbortController();
    expiredController.abort(new ScrapeJobTimeoutError());
    const expiredManager = new AbortManager({
      signal: expiredController.signal,
      tier: "scrape",
      timesOutAt: new Date(Date.now()),
      throwable: () => new ScrapeJobTimeoutError(),
    });
    const mapped = expiredManager.asSignal();
    expect(mapped.aborted).toBe(true);
    expect(mapped.reason).toBeInstanceOf(AbortManagerThrownError);
    expect((mapped.reason as AbortManagerThrownError).inner).toBeInstanceOf(
      ScrapeJobTimeoutError,
    );
  });

  it("short-circuits before engine selection when scrape.start throws", async () => {
    const fetchScrape = vi.fn();
    const selectHook = vi.fn();

    installTestService(
      [makeEngine("fetch", fetchScrape, { quality: 20 })],
      [
        {
          name: "veto-start",
          hooks: {
            "scrape.start": (_plan, meta) => {
              (meta.state as Record<string, unknown>).vetoedAt = "scrape.start";
              throw new Error("blocked at start");
            },
            "scrape.engines.select": selectHook,
          },
        },
      ],
    );

    const result = await scrapeURL(
      "scrape-start-veto",
      "https://example.com/blocked",
      scrapeOptions.parse({ formats: ["markdown"] }),
      { teamId: "team-veto", orgId: null },
      new CostTracking(),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.message).toBe("blocked at start");
    expect(result.state).toEqual({ vetoedAt: "scrape.start" });
    expect(selectHook).not.toHaveBeenCalled();
    expect(fetchScrape).not.toHaveBeenCalled();
  });

  it("short-circuits before transformers when scrape.fetched throws", async () => {
    const markdownHook = vi.fn();

    installTestService(
      [
        makeEngine("fetch", async () => ({
          url: "https://example.com/redirected",
          html: "<html><body><p>Body text</p></body></html>",
          statusCode: 200,
          proxyUsed: "basic",
        })),
      ],
      [
        {
          name: "veto-fetched",
          hooks: {
            "scrape.fetched": (_result, meta) => {
              (meta.state as Record<string, unknown>).vetoedAt =
                "scrape.fetched";
              throw new Error("blocked after fetch");
            },
            "scrape.document.markdown": markdownHook,
          },
        },
      ],
    );

    const result = await scrapeURL(
      "scrape-fetched-veto",
      "https://example.com/initial",
      scrapeOptions.parse({ formats: ["markdown"] }),
      { teamId: "team-veto", orgId: null },
      new CostTracking(),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.message).toBe("blocked after fetch");
    expect(result.state).toEqual({ vetoedAt: "scrape.fetched" });
    expect(markdownHook).not.toHaveBeenCalled();
  });

  it("emits scrape.finished once, awaits errors, and supports failure payloads", async () => {
    const onFinished = vi.fn(async (event: ScrapeFinished) => {
      if (event.document !== null) {
        throw new Error("monitor recording failed");
      }
    });

    installTestService(
      [],
      [{ name: "finished-hook", hooks: { "scrape.finished": onFinished } }],
    );

    const ctx = requestContext({
      teamId: "team-finished",
      zeroDataRetention: true,
      orgId: null,
    });
    const options = scrapeOptions.parse({ formats: ["markdown"] });
    const sharedState: Record<string, unknown> = { stage: "done" };

    const emitSuccess = createScrapeFinishedEmitter({
      jobId: "job-1",
      requestId: "req-1",
      kind: "crawl",
      ctx,
      url: "https://example.com/a",
      options,
      getState: () => sharedState,
    });

    await expect(
      emitSuccess({
        document: { metadata: { statusCode: 200, proxyUsed: "basic" } },
        charged: 1,
        timeTakenMs: 100,
      }),
    ).rejects.toThrow("monitor recording failed");

    // A second call from a catch path must not emit a duplicate event.
    await emitSuccess({
      document: null,
      error: new Error("monitor recording failed"),
      charged: 0,
      timeTakenMs: 120,
    });
    expect(onFinished).toHaveBeenCalledTimes(1);

    const emitFailure = createScrapeFinishedEmitter({
      jobId: "job-2",
      kind: "batchScrape",
      ctx,
      url: "https://example.com/b",
      options,
      getState: () => undefined,
    });
    const failure = new Error("scrape failed");
    await emitFailure({
      document: null,
      error: failure,
      charged: undefined,
      timeTakenMs: 55,
    });

    expect(onFinished).toHaveBeenCalledTimes(2);
    expect(onFinished.mock.calls[1][0]).toEqual({
      jobId: "job-2",
      requestId: undefined,
      kind: "batchScrape",
      ctx,
      url: "https://example.com/b",
      options,
      state: {},
      document: null,
      error: failure,
      charged: undefined,
      timeTakenMs: 55,
    });
  });

  it("allows executeTransformers and scrape.finished emitter to run without an installed service", async () => {
    replaceService(undefined);
    const log = {
      child: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    log.child.mockReturnValue(log);

    const document = await executeTransformers(
      {
        url: "https://example.com/no-service",
        options: {
          formats: [{ type: "markdown" }],
          onlyMainContent: false,
        },
        internalOptions: {},
        logger: log,
      } as any,
      {
        rawHtml: "<html><body><h1>Standalone</h1></body></html>",
        markdown: "# Standalone",
        metadata: {
          sourceURL: "https://example.com/no-service",
          url: "https://example.com/no-service",
          statusCode: 200,
        },
      } as any,
    );

    expect(document.markdown).toBe("# Standalone");

    const emitFinished = createScrapeFinishedEmitter({
      jobId: "job-no-service",
      kind: "scrape",
      ctx: requestContext({ teamId: "t", zeroDataRetention: false }),
      url: "https://example.com/no-service",
      options: scrapeOptions.parse({ formats: ["markdown"] }),
      getState: () => undefined,
    });
    await expect(
      emitFinished({
        document,
        charged: undefined,
        timeTakenMs: 10,
      }),
    ).resolves.toBeUndefined();
  });
});
