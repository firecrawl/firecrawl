import { createLogger } from "winston";
import type { performLLMExtract as performLLMExtractFn } from "./llmExtract";
import type { Meta } from "..";
import type { Document } from "../../../controllers/v2/types";
import {
  applyScrapeOptionsDefaults,
  scrapeOptions,
} from "../../../controllers/v2/types";
import { CostTracking } from "../../../lib/cost-tracking";
import { AbortManager } from "../lib/abortManager";
import { executeTransformers } from ".";
import { performLLMExtract } from "./llmExtract";

vi.mock("./llmExtract", async importOriginal => {
  const actual = await importOriginal<{
    performLLMExtract: typeof performLLMExtractFn;
  }>();

  return {
    ...actual,
    performLLMExtract: vi.fn(actual.performLLMExtract),
  };
});

const mockedPerformLLMExtract = vi.mocked(performLLMExtract);

describe("executeTransformers", () => {
  beforeEach(() => {
    mockedPerformLLMExtract.mockClear();
  });

  it("runs JSON extraction on markdown an engine delivered natively", async () => {
    mockedPerformLLMExtract.mockImplementationOnce(async (_meta, document) => ({
      ...document,
      json: { name: "Example Person" },
    }));

    const meta: Meta = {
      id: "test-scrape",
      url: "https://www.linkedin.com/in/example",
      ctx: { teamId: "test-team", zeroDataRetention: false },
      state: {},
      options: {
        ...applyScrapeOptionsDefaults(scrapeOptions.parse({})),
        formats: [
          { type: "markdown" },
          { type: "json", schema: { type: "object" } },
        ],
        onlyMainContent: false,
      },
      internalOptions: { teamId: "test-team", orgId: null },
      logger: createLogger({ silent: true }),
      abort: new AbortManager(),
      featureFlags: new Set(),
      mock: null,
      imageOcrEnabled: async () => false,
      pdfPrefetch: undefined,
      documentPrefetch: undefined,
      imagePrefetch: undefined,
      fetchPrefetch: undefined,
      costTracking: new CostTracking(),
      threatDecisions: [],
    };

    const inputDoc: Document = {
      rawHtml:
        "<html><head><title>Example</title></head><body><h1>Example Person</h1></body></html>",
      markdown: "# Example Person",
      metadata: {
        sourceURL: "https://www.linkedin.com/in/example",
        url: "https://www.linkedin.com/in/example",
        statusCode: 200,
        contentType: "text/markdown; charset=utf-8",
        proxyUsed: "basic",
      },
    };

    const document = await executeTransformers(meta, inputDoc);

    expect(mockedPerformLLMExtract).toHaveBeenCalledTimes(1);
    expect(document.markdown).toBe("# Example Person");
    expect(document.json).toEqual({ name: "Example Person" });
  });

  it("strips NUL characters from engine-delivered markdown and rawHtml", async () => {
    const meta: Meta = {
      id: "test-scrape-nul",
      url: "https://example.com/form.pdf",
      ctx: { teamId: "test-team", zeroDataRetention: false },
      state: {},
      options: {
        ...applyScrapeOptionsDefaults(scrapeOptions.parse({})),
        formats: [{ type: "markdown" }, { type: "rawHtml" }],
        onlyMainContent: false,
      },
      internalOptions: { teamId: "test-team", orgId: null },
      logger: createLogger({ silent: true }),
      abort: new AbortManager(),
      featureFlags: new Set(),
      mock: null,
      imageOcrEnabled: async () => false,
      pdfPrefetch: undefined,
      documentPrefetch: undefined,
      imagePrefetch: undefined,
      fetchPrefetch: undefined,
      costTracking: new CostTracking(),
      threatDecisions: [],
    };

    const inputDoc: Document = {
      rawHtml: "<p>field: S\u0000c\u0000h</p>",
      markdown: "field: S\u0000c\u0000h",
      metadata: {
        sourceURL: "https://example.com/form.pdf",
        url: "https://example.com/form.pdf",
        statusCode: 200,
        contentType: "application/pdf",
        proxyUsed: "basic",
      },
    };

    const document = await executeTransformers(meta, inputDoc);

    expect(document.markdown).toBe("field: Sch");
    expect(document.rawHtml).toBe("<p>field: Sch</p>");
  });
});
