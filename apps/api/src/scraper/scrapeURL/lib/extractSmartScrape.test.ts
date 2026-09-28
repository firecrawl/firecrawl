import { vi } from "vitest";

vi.mock("../transformers/llmExtract", () => ({
  generateCompletions: vi.fn(),
  generateSchemaFromPrompt: vi.fn(),
}));

vi.mock("./promptInjectionGuard", () => ({
  checkForPromptInjection: vi.fn(async () => true),
  createPromptInjectionGuardLimiter: vi.fn(),
}));

import type { Mock } from "vitest";
import { extractData } from "./extractSmartScrape";
import { generateCompletions } from "../transformers/llmExtract";
import { checkForPromptInjection } from "./promptInjectionGuard";
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
    function run(ids: { scrapeId?: string; extractId?: string }) {
      (generateCompletions as Mock).mockResolvedValueOnce({
        extract: { ok: true },
        warning: undefined,
        totalUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      });
      return extractData({
        extractOptions: {
          logger: noopLogger,
          options: {
            schema: { type: "object", properties: {} },
            checkPromptInjection: true,
          },
          markdown: "page",
          costTrackingOptions: {
            costTracking: new CostTracking(),
            metadata: {},
          },
          metadata: { teamId: "test-team" },
        } as any,
        urls: ["https://example.com"],
        useAgent: false,
        ...ids,
        metadata: { teamId: "test-team", functionId: "performLLMExtract" },
      });
    }

    beforeEach(() => {
      (checkForPromptInjection as Mock).mockClear();
    });

    it("passes the scrape id to the guard for its span metadata", async () => {
      await run({ scrapeId: "test-scrape" });

      expect(checkForPromptInjection).toHaveBeenCalledTimes(1);
      expect(
        (checkForPromptInjection as Mock).mock.calls[0][0].metadata,
      ).toEqual({
        teamId: "test-team",
        functionId: "performLLMExtract",
        scrapeId: "test-scrape",
        extractId: undefined,
      });
    });

    it("passes the extract id to the guard for its span metadata", async () => {
      await run({ extractId: "test-extract" });

      expect(
        (checkForPromptInjection as Mock).mock.calls[0][0].metadata,
      ).toMatchObject({ teamId: "test-team", extractId: "test-extract" });
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
