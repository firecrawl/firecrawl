import { vi } from "vitest";

vi.mock("ai", async importOriginal => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateObject: vi.fn(), generateText: vi.fn() };
});

import { generateObject, generateText, NoObjectGeneratedError } from "ai";
import type { Mock } from "vitest";
import { generateCompletions, isTruncatedJson } from "./llmExtract";
import { CostTracking } from "../../../lib/cost-tracking";

const noopLogger = {
  warn: () => {},
  info: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
} as any;

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
    model: { modelId: "gpt-4o-mini" } as any,
    retryModel: { modelId: "gpt-4.1-mini" } as any,
    costTrackingOptions: { costTracking: new CostTracking(), metadata: {} },
    metadata: { teamId: "test-team" },
  });
}

// Mirrors the SDK: the repair hook runs on the unparseable text, and the call
// fails if it returns null.
function respondWith(text: string, finishReason: "length" | "stop") {
  (generateObject as Mock).mockImplementationOnce(async args => {
    const repaired = await args.experimental_repairText({
      text,
      error: new Error("parse failed"),
    });
    if (repaired !== null) {
      return {
        object: JSON.parse(repaired),
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }
    throw new NoObjectGeneratedError({
      message: "No object generated: could not parse the response.",
      text,
      response: {} as any,
      usage: {} as any,
      finishReason,
    });
  });
}

beforeEach(() => {
  (generateObject as Mock).mockReset();
  (generateText as Mock).mockReset();
});

describe("isTruncatedJson", () => {
  it.each([
    ['{"items": ["a", "b"', true],
    ['{"items": ["a", "unterminated', true],
    ['```json\n{"items": [', true],
    ['{"quote": "\\"}', true],
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
    expect(generateText).not.toHaveBeenCalled();
  });

  it("still repairs complete output wrapped in a code block", async () => {
    respondWith('```json\n{"items": ["a"]}\n```', "stop");

    const result = await run();

    expect(result.extract).toEqual({ items: ["a"] });
    expect(generateText).not.toHaveBeenCalled();
  });
});
