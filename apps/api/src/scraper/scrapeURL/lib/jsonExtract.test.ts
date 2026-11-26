import { vi } from "vitest";
import { createLogger } from "winston";

vi.mock("../transformers/llmExtract", () => ({
  generateCompletions: vi.fn(),
  generateSchemaFromPrompt: vi.fn(),
}));

vi.mock("./promptInjectionGuard", () => ({
  checkForPromptInjection: vi.fn(async () => true),
  createPromptInjectionGuardLimiter: vi.fn(),
}));

import { z } from "zod";
import { jsonRecordSchema, jsonValueSchema } from "../../../lib/json-types";
import type { JsonObject, JsonValue } from "../../../lib/json-types";
import { extractData } from "./jsonExtract";
import { generateCompletions } from "../transformers/llmExtract";
import { checkForPromptInjection } from "./promptInjectionGuard";
import { JsonExtractionContentTooLargeError } from "../error";
import { CostTracking } from "../../../lib/cost-tracking";

const noopLogger = createLogger({ silent: true });
const jsonOrRecordSchema = z.union([jsonValueSchema, jsonRecordSchema]);

function runExtract(schema: JsonObject | undefined) {
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
    },
    metadata: { teamId: "test-team" },
  });
}

function sentSchema(): JsonValue | undefined {
  const calls = vi.mocked(generateCompletions).mock.calls;
  const lastCall = calls.at(-1);
  const parsed = jsonOrRecordSchema.safeParse(lastCall?.[0].options.schema);
  return parsed.success ? parsed.data : undefined;
}

function mockExtract(extract: JsonValue | undefined) {
  vi.mocked(generateCompletions).mockResolvedValueOnce({
    extract,
    numTokens: 0,
    warning: undefined,
    totalUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    model: "gpt-4o-mini",
  });
}

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
        },
        metadata: { teamId: "test-team" },
      }),
    ).rejects.toBeInstanceOf(JsonExtractionContentTooLargeError);
  });

  describe("prompt injection guard", () => {
    it("leaves the page itself to the scrape-level guard", async () => {
      vi.mocked(checkForPromptInjection).mockClear();
      mockExtract({ ok: true });

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
        },
        scrapeId: "test-scrape",
        metadata: { teamId: "test-team" },
      });

      expect(checkForPromptInjection).not.toHaveBeenCalled();
    });
  });

  describe("schema handling", () => {
    it("sends the user's schema as-is", async () => {
      const schema = {
        judgments: { type: "array", items: { type: "string" } },
      };
      mockExtract({ judgments: ["a"] });

      const result = await runExtract(schema);

      expect(sentSchema()).toEqual(schema);
      expect(result.extractedDataArray).toEqual([{ judgments: ["a"] }]);
    });

    it("extracts without a schema when none was given", async () => {
      mockExtract({ anything: 1 });

      const result = await runExtract(undefined);

      expect(sentSchema()).toBeUndefined();
      expect(result.extractedDataArray).toEqual([{ anything: 1 }]);
    });

    it("returns root array results as the array itself", async () => {
      mockExtract({ items: [{ name: "a" }, { name: "b" }] });

      const result = await runExtract({
        type: "Array",
        items: { type: "object", properties: { name: { type: "string" } } },
      });

      expect(result.extractedDataArray).toEqual([
        [{ name: "a" }, { name: "b" }],
      ]);
    });
  });
});
