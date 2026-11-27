import { vi } from "vitest";
import type {
  generateObject as generateObjectFn,
  generateText as generateTextFn,
} from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createLogger } from "winston";

type GenerateObjectArgs = Parameters<typeof generateObjectFn>[0];
type MockGenerateObjectResult = {
  object: unknown;
  usage: { inputTokens: number; outputTokens: number };
};

const mocks = vi.hoisted(() => ({
  generateObject:
    vi.fn<(args: GenerateObjectArgs) => Promise<MockGenerateObjectResult>>(),
  generateText: vi.fn(),
}));

vi.mock("ai", async importOriginal => {
  const actual = await importOriginal<{
    generateObject: typeof generateObjectFn;
    generateText: typeof generateTextFn;
  }>();
  return {
    ...actual,
    generateObject: mocks.generateObject,
    generateText: mocks.generateText,
  };
});

import { JSONParseError, NoObjectGeneratedError } from "ai";
import { generateCompletions, isTruncatedJson } from "./llmExtract";
import { CostTracking } from "../../../lib/cost-tracking";

const noopLogger = createLogger({ silent: true });

function run() {
  return generateCompletions({
    logger: noopLogger,
    options: {
      schema: {
        type: "object",
        properties: { items: { type: "array", items: { type: "string" } } },
      },
    },
    markdown: "page",
    model: new MockLanguageModelV3({ modelId: "gpt-4o-mini" }),
    retryModel: new MockLanguageModelV3({ modelId: "gpt-4.1-mini" }),
    costTrackingOptions: { costTracking: new CostTracking(), metadata: {} },
    metadata: { teamId: "test-team" },
  });
}

// Mirrors the SDK: the repair hook runs on the unparseable text, and the call
// fails if it returns null.
function respondWith(text: string, finishReason: "length" | "stop") {
  mocks.generateObject.mockImplementationOnce(async args => {
    const repaired = await args.experimental_repairText?.({
      text,
      error: new JSONParseError({ text, cause: new Error("parse failed") }),
    });
    if (repaired !== null && repaired !== undefined) {
      const parsed: unknown = JSON.parse(repaired);
      return {
        object: parsed,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }
    throw new NoObjectGeneratedError({
      message: "No object generated: could not parse the response.",
      text,
      response: {
        id: "test-response",
        timestamp: new Date(0),
        modelId: "gpt-4o-mini",
      },
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        inputTokenDetails: {
          noCacheTokens: 0,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokenDetails: {
          textTokens: 0,
          reasoningTokens: undefined,
        },
      },
      finishReason,
    });
  });
}

beforeEach(() => {
  mocks.generateObject.mockReset();
  mocks.generateText.mockReset();
});

describe("isTruncatedJson", () => {
  it.each([
    ['{"items": ["a", "b"', true],
    ['{"items": ["a", "unterminated', true],
    ['```json\n{"items": [', true],
    [String.raw`{"quote": "\"}`, true],
    ['{"items": ["a", "b"]}', false],
    ['```json\n{"items": ["a"]}\n```', false],
    ['{"brace": "}", "bracket": "["}', false],
    ["not json at all", false],
    ['{"items": [1, 2}', false],
    ['[{"a": 1]', false],
    ['{"a": 1}}', false],
  ])("%s -> %s", (text, expected) => {
    expect(isTruncatedJson(text)).toBe(expected);
  });
});

describe("generateCompletions at the output token limit", () => {
  it("returns nothing and skips the LLM repair when output was cut off", async () => {
    respondWith('{"items": ["a", "b", "c', "length");

    await expect(run()).rejects.toThrow(
      "the extracted data exceeded the model's maximum output length",
    );
    expect(mocks.generateText).not.toHaveBeenCalled();
  });

  it("still repairs complete output wrapped in a code block", async () => {
    respondWith('```json\n{"items": ["a"]}\n```', "stop");

    const result = await run();

    expect(result.extract).toEqual({ items: ["a"] });
    expect(mocks.generateText).not.toHaveBeenCalled();
  });
});
