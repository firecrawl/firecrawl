import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Engine as RegisteredEngine } from "../../service/engines";
import type { Extension } from "../../service/service";
import { createService, replaceService } from "../../service/service";
import { scrapeOptions } from "../../controllers/v2/types";
import { CostTracking } from "../../lib/cost-tracking";

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
import { EngineError } from "./error";
import { htmlTransform } from "./lib/removeUnwantedElements";
import { executeTransformers } from "./transformers";

const makeEngine = (
  name: string,
  scrape: RegisteredEngine["scrape"],
  quality = 10,
): RegisteredEngine =>
  ({
    name,
    quality,
    features: {},
    enabled: () => true,
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
  it("runs all 9 in-pipeline scrape hooks in order with shared ScrapeState", async () => {
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

    installTestService(
      [
        makeEngine("fetch", fetchScrape, 20),
        makeEngine("playwright", playwrightScrape, 10),
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
          },
        },
      ],
    );

    const result = await scrapeURL(
      "scrape-hooks-e2e",
      "https://example.com/page",
      scrapeOptions.parse({ formats: ["markdown", "html"] }),
      { teamId: "team-hooks", orgId: null },
      new CostTracking(),
    );

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(fetchScrape).toHaveBeenCalledTimes(1);
    expect(playwrightScrape).toHaveBeenCalledTimes(1);
    expect(result.document.markdown).toContain("FromFetchedHook");
    expect(result.document.markdown).toContain("<!-- md-hook -->");
    expect(result.document.metadata.title).toBe("Derived Title");
    expect(result.document.warning).toBe("final-hook-note");
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
    ]);

    const cleanCall = vi
      .mocked(htmlTransform)
      .mock.calls.find(call => call[3] !== undefined);
    expect(cleanCall?.[3]).toEqual(["sig-nav"]);
  });

  it("short-circuits before engine selection when scrape.start throws", async () => {
    const fetchScrape = vi.fn();
    const selectHook = vi.fn();

    installTestService(
      [makeEngine("fetch", fetchScrape, 20)],
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

  it("allows executeTransformers to run without an installed service", async () => {
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
  });
});
