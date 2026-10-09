import { vi } from "vitest";

vi.mock("../transformers/llmExtract", () => ({
  generateCompletions: vi.fn(),
  generateSchemaFromPrompt: vi.fn(),
}));

vi.mock("./promptInjectionGuard", () => ({
  checkForPromptInjection: vi.fn(async () => true),
  createPromptInjectionGuardLimiter: vi.fn(),
}));

vi.mock("./smartScrape", () => ({
  smartScrape: vi.fn(),
}));

vi.mock("../../../lib/html-to-markdown", () => ({
  parseMarkdown: vi.fn(async () => "smartscraped page"),
}));

import type { Mock } from "vitest";
import { extractData } from "./extractSmartScrape";
import { generateCompletions } from "../transformers/llmExtract";
import { checkForPromptInjection } from "./promptInjectionGuard";
import { smartScrape } from "./smartScrape";
import { JsonExtractionContentTooLargeError } from "../error";
import { CostTracking } from "../../../lib/cost-tracking";

const noopLogger = {
  warn: () => {},
  info: () => {},
  error: () => {},
  debug: () => {},
} as any;

describe("extractData", () => {
  it("rejects markdown over the size cap before any extraction call, regardless of checkPromptInjection", async () => {
    const markdown = "x".repeat(2_100_000);

    await expect(
      extractData({
        extractOptions: {
          logger: noopLogger,
          options: { schema: { type: "object", properties: {} } },
          markdown,
          costTrackingOptions: {
            costTracking: new CostTracking(),
            metadata: {},
          },
          metadata: { teamId: "test-team" },
        } as any,
        urls: ["https://example.com"],
        useAgent: false,
        metadata: { teamId: "test-team" },
      }),
    ).rejects.toBeInstanceOf(JsonExtractionContentTooLargeError);
  });

  describe("prompt injection guard", () => {
    it("leaves the page itself to the scrape-level guard", async () => {
      (checkForPromptInjection as Mock).mockClear();
      (generateCompletions as Mock).mockResolvedValueOnce({
        extract: { ok: true },
        warning: undefined,
        totalUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      });

      await extractData({
        extractOptions: {
          logger: noopLogger,
          options: { schema: { type: "object", properties: {} } },
          markdown: "page",
          costTrackingOptions: {
            costTracking: new CostTracking(),
            metadata: {},
          },
          metadata: { teamId: "test-team" },
        } as any,
        urls: ["https://example.com"],
        useAgent: false,
        checkPromptInjection: true,
        scrapeId: "test-scrape",
        metadata: { teamId: "test-team" },
      });

      expect(checkForPromptInjection).not.toHaveBeenCalled();
    });

    it("scans each page SmartScrape fetches", async () => {
      (checkForPromptInjection as Mock).mockClear();
      (smartScrape as Mock).mockResolvedValueOnce({
        scrapedPages: [{ html: "<p>page</p>" }],
      });
      (generateCompletions as Mock)
        .mockResolvedValueOnce({
          extract: {
            extractedData: null,
            shouldUseSmartscrape: true,
            smartscrape_prompt: "find the title",
          },
          warning: undefined,
          totalUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        })
        .mockResolvedValueOnce({ extract: { title: "t" } });

      await extractData({
        extractOptions: {
          logger: noopLogger,
          options: {
            schema: {
              type: "object",
              properties: { title: { type: "string" } },
            },
          },
          markdown: "page",
          costTrackingOptions: {
            costTracking: new CostTracking(),
            metadata: {},
          },
          metadata: { teamId: "test-team" },
        } as any,
        urls: ["https://example.com"],
        useAgent: true,
        checkPromptInjection: true,
        scrapeId: "test-scrape",
        metadata: { teamId: "test-team", functionId: "performLLMExtract" },
      });

      expect(checkForPromptInjection).toHaveBeenCalledTimes(1);
      expect((checkForPromptInjection as Mock).mock.calls[0][0]).toMatchObject({
        markdown: "smartscraped page",
        metadata: {
          teamId: "test-team",
          functionId: "performLLMExtract",
          scrapeId: "test-scrape",
        },
      });
    });
  });

  describe("SmartScrape schema wrapping", () => {
    function run(schema: any, useAgent: boolean) {
      return extractData({
        extractOptions: {
          logger: noopLogger,
          options: { schema },
          markdown: "page",
          costTrackingOptions: {
            costTracking: new CostTracking(),
            metadata: {},
          },
          metadata: { teamId: "test-team" },
        } as any,
        urls: ["https://example.com"],
        useAgent,
        metadata: { teamId: "test-team" },
      });
    }

    function sentSchema() {
      const calls = (generateCompletions as Mock).mock.calls;
      return calls[calls.length - 1][0].options.schema;
    }

    function mockExtract(extract: any) {
      (generateCompletions as Mock).mockResolvedValueOnce({
        extract,
        warning: undefined,
        totalUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      });
    }

    it("sends the user's schema as-is when the agent is off", async () => {
      const schema = {
        judgments: { type: "array", items: { type: "string" } },
      };
      mockExtract({ judgments: ["a"] });

      const result = await run(schema, false);

      expect(sentSchema()).toEqual(schema);
      expect(result.extractedDataArray).toEqual([{ judgments: ["a"] }]);
    });

    it("extracts without a schema when none was given", async () => {
      mockExtract({ anything: 1 });

      const result = await run(undefined, false);

      expect(sentSchema()).toBeUndefined();
      expect(result.extractedDataArray).toEqual([{ anything: 1 }]);
    });

    it("returns root array results as the array itself", async () => {
      mockExtract({ items: [{ name: "a" }, { name: "b" }] });

      const result = await run(
        {
          type: "Array",
          items: { type: "object", properties: { name: { type: "string" } } },
        },
        false,
      );

      expect(result.extractedDataArray).toEqual([
        [{ name: "a" }, { name: "b" }],
      ]);
    });

    it("still wraps the schema for the agent", async () => {
      const schema = {
        type: "object",
        properties: { title: { type: "string" } },
      };
      mockExtract({
        extractedData: { title: "t" },
        shouldUseSmartscrape: false,
      });

      const result = await run(schema, true);

      expect(sentSchema().properties.extractedData).toEqual(schema);
      expect(sentSchema().required).toContain("extractedData");
      expect(result.extractedDataArray).toEqual([{ title: "t" }]);
    });

    it("turns a bare property map into an object schema before wrapping", async () => {
      mockExtract({
        extractedData: { title: "t" },
        shouldUseSmartscrape: false,
      });

      await run({ title: { type: "string" } }, true);

      expect(sentSchema().properties.extractedData).toEqual({
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
        additionalProperties: false,
      });
    });
  });
});
