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
import { extractData } from "./jsonExtract";
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
  it("rejects markdown over the size cap before any extraction call", async () => {
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
        scrapeId: "test-scrape",
        metadata: { teamId: "test-team" },
      });

      expect(checkForPromptInjection).not.toHaveBeenCalled();
    });
  });

  describe("schema handling", () => {
    function run(schema: any) {
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

    it("sends the user's schema as-is", async () => {
      const schema = {
        judgments: { type: "array", items: { type: "string" } },
      };
      mockExtract({ judgments: ["a"] });

      const result = await run(schema);

      expect(sentSchema()).toEqual(schema);
      expect(result.extractedDataArray).toEqual([{ judgments: ["a"] }]);
    });

    it("extracts without a schema when none was given", async () => {
      mockExtract({ anything: 1 });

      const result = await run(undefined);

      expect(sentSchema()).toBeUndefined();
      expect(result.extractedDataArray).toEqual([{ anything: 1 }]);
    });

    it("returns root array results as the array itself", async () => {
      mockExtract({ items: [{ name: "a" }, { name: "b" }] });

      const result = await run({
        type: "Array",
        items: { type: "object", properties: { name: { type: "string" } } },
      });

      expect(result.extractedDataArray).toEqual([
        [{ name: "a" }, { name: "b" }],
      ]);
    });
  });
});
