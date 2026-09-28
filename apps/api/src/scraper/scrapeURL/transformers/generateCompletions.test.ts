import { vi } from "vitest";

vi.mock("ai", async importOriginal => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateObject: vi.fn(async () => ({
      object: { ok: true },
      usage: { inputTokens: 1, outputTokens: 1 },
    })),
  };
});

import { generateObject } from "ai";
import { encoding_for_model } from "@dqbd/tiktoken";
import type { Mock } from "vitest";
import { generateCompletions } from "./llmExtract";
import { CostTracking } from "../../../lib/cost-tracking";
import { modelPrices } from "../../../lib/extract/usage/model-prices";

const noopLogger = {
  warn: () => {},
  info: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
} as any;

function run(markdown: string, modelId: string, schema?: any) {
  return generateCompletions({
    logger: noopLogger,
    options: { schema },
    markdown,
    model: { modelId } as any,
    retryModel: { modelId } as any,
    costTrackingOptions: { costTracking: new CostTracking(), metadata: {} },
    metadata: { teamId: "test-team" },
  });
}

function lastCall() {
  const calls = (generateObject as Mock).mock.calls;
  expect(calls).toHaveLength(1);
  return calls[0][0];
}

function countTokens(text: string): number {
  const encoder = encoding_for_model("gpt-4o-mini");
  try {
    return encoder.encode(text).length;
  } finally {
    encoder.free();
  }
}

beforeEach(() => {
  (generateObject as Mock).mockClear();
});

describe("generateCompletions content trimming", () => {
  // ~3.3 characters per token like real pages: ~400k tokens, three times
  // gpt-4o-mini's window.
  const hugeMarkdown =
    "The quick brown fox jumps over the lazy dog. [link](https://example.com/a/b?c=1) 12345 ".repeat(
      15_000,
    );

  it("trims content that would overflow the model's context window", async () => {
    const result = await run(hugeMarkdown, "gpt-4o-mini");

    expect(result.warning).toContain(
      "the input has been automatically trimmed",
    );
    // The content is trimmed to exactly 80% of the window; the rest of the
    // prompt is a short instruction.
    const budget = Math.floor(
      modelPrices["gpt-4o-mini"].max_input_tokens * 0.8,
    );
    const promptTokens = countTokens(lastCall().prompt);
    expect(promptTokens).toBeGreaterThan(budget);
    expect(promptTokens).toBeLessThanOrEqual(budget + 100);
  });

  it("leaves content that fits untouched", async () => {
    const markdown = "a small page";
    const result = await run(markdown, "gpt-4o-mini");

    expect(result.warning).toBeUndefined();
    expect(lastCall().prompt).toContain(markdown);
  });

  it("does not trim for models without known limits", async () => {
    const result = await run(hugeMarkdown, "some-unlisted-model");

    expect(result.warning).toBeUndefined();
    expect(lastCall().prompt).toContain(hugeMarkdown);
  });
});

describe("generateCompletions schema normalization", () => {
  it("turns a bare property map into an object schema, skipping $schema", async () => {
    await run("page", "gpt-4o-mini", {
      $schema: "http://json-schema.org/draft-07/schema#",
      judgments: {
        type: "array",
        items: {
          type: "object",
          properties: { citation: { type: "String" } },
        },
      },
    });

    expect(lastCall().schema.jsonSchema).toEqual({
      type: "object",
      properties: {
        judgments: {
          type: "array",
          items: {
            type: "object",
            properties: { citation: { type: "string" } },
            required: ["citation"],
            additionalProperties: false,
          },
        },
      },
      required: ["judgments"],
      additionalProperties: false,
    });
  });

  it("wraps nullable root arrays in an object", async () => {
    await run("page", "gpt-4o-mini", {
      type: ["array", "null"],
      items: { type: "string" },
    });

    expect(lastCall().schema.jsonSchema).toEqual({
      type: "object",
      properties: {
        items: { type: ["array", "null"], items: { type: "string" } },
      },
      required: ["items"],
      additionalProperties: false,
    });
  });

  it("closes nullable objects so strict mode accepts them", async () => {
    await run("page", "gpt-4o-mini", {
      type: "object",
      properties: {
        address: {
          type: ["object", "null"],
          properties: { city: { type: "string" } },
        },
      },
    });

    expect(lastCall().schema.jsonSchema.properties.address).toEqual({
      type: ["object", "null"],
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    });
  });
});
