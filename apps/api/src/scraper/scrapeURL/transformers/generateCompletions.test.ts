import { vi } from "vitest";
import type { generateObject as generateObjectFn } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createLogger } from "winston";

type GenerateObjectArgs = Parameters<typeof generateObjectFn>[0];
type MockGenerateObjectResult = {
  object: JsonObject;
  usage: { inputTokens: number; outputTokens: number };
};

const mocks = vi.hoisted(() => ({
  generateObject: vi.fn<
    (args: GenerateObjectArgs) => Promise<MockGenerateObjectResult>
  >(async () => ({
    object: { ok: true },
    usage: { inputTokens: 1, outputTokens: 1 },
  })),
}));

vi.mock("../../../lib/ai-telemetry", () => ({
  aiTelemetry: (options: unknown) => options,
}));
vi.mock("ai", async importOriginal => {
  const actual = await importOriginal<{
    generateObject: typeof generateObjectFn;
  }>();
  return {
    ...actual,
    generateObject: mocks.generateObject,
  };
});

import { encoding_for_model } from "@dqbd/tiktoken";
import { z } from "zod";
import {
  generateCompletions,
  generateCrawlerOptionsFromPrompt,
} from "./llmExtract";
import { CostTracking } from "../../../lib/cost-tracking";
import { coreLlmProviders } from "../../../lib/generic-ai";
import { jsonRecordSchema } from "../../../lib/json-types";
import type { JsonObject } from "../../../lib/json-types";
import { modelPrices } from "../../../lib/model-prices";
import { createService, replaceService } from "../../../service/service";

const noopLogger = createLogger({ silent: true });

const wrappedJsonSchema = z.object({
  schema: z.object({
    jsonSchema: jsonRecordSchema,
  }),
});

const telemetrySchema = z.object({
  functionId: z.string().optional(),
  metadata: jsonRecordSchema.optional(),
});

const schemaWithPropertiesSchema = z.object({
  properties: jsonRecordSchema,
});

function run(markdown: string, modelId: string, schema?: unknown) {
  return generateCompletions({
    logger: noopLogger,
    options: { schema },
    markdown,
    model: new MockLanguageModelV3({ modelId }),
    retryModel: new MockLanguageModelV3({ modelId }),
    costTrackingOptions: { costTracking: new CostTracking(), metadata: {} },
    metadata: { teamId: "test-team" },
  });
}

function lastCall(): GenerateObjectArgs {
  const calls = mocks.generateObject.mock.calls;
  expect(calls).toHaveLength(1);
  return calls[0][0];
}

function lastCallPrompt(): string {
  const prompt = lastCall().prompt;
  if (typeof prompt !== "string") {
    throw new Error("Expected string prompt");
  }
  return prompt;
}

function lastCallJsonSchema(): JsonObject {
  const parsed = wrappedJsonSchema.safeParse(lastCall());
  if (!parsed.success) {
    throw new Error("Expected schema.jsonSchema object");
  }
  return parsed.data.schema.jsonSchema;
}

function lastCallTelemetry() {
  const parsed = telemetrySchema.safeParse(lastCall().telemetry);
  if (!parsed.success) {
    throw new Error("Expected telemetry object");
  }
  return {
    functionId: parsed.data.functionId,
    metadata: parsed.data.metadata,
  };
}

function countTokens(text: string): number {
  const encoder = encoding_for_model("gpt-4o-mini");
  try {
    return encoder.encode(text).length;
  } finally {
    encoder.free();
  }
}

beforeAll(() => {
  replaceService(
    createService(
      { modules: {} },
      {
        core: { name: "core", llmProviders: coreLlmProviders },
        logger: { error: vi.fn() },
      },
    ),
  );
});

afterAll(() => {
  replaceService(undefined);
});

beforeEach(() => {
  mocks.generateObject.mockClear();
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
    const promptTokens = countTokens(lastCallPrompt());
    expect(promptTokens).toBeGreaterThan(budget);
    expect(promptTokens).toBeLessThanOrEqual(budget + 100);
  });

  it("leaves content that fits untouched", async () => {
    const markdown = "a small page";
    const result = await run(markdown, "gpt-4o-mini");

    expect(result.warning).toBeUndefined();
    expect(lastCallPrompt()).toContain(markdown);
  });

  it("does not trim for models without known limits", async () => {
    const result = await run(hugeMarkdown, "some-unlisted-model");

    expect(result.warning).toBeUndefined();
    expect(lastCallPrompt()).toContain(hugeMarkdown);
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

    expect(lastCallJsonSchema()).toEqual({
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

    expect(lastCallJsonSchema()).toEqual({
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

    const parsedSchema =
      schemaWithPropertiesSchema.safeParse(lastCallJsonSchema());
    expect(
      parsedSchema.success ? parsedSchema.data.properties.address : undefined,
    ).toEqual({
      type: ["object", "null"],
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    });
  });
});

describe("generateCompletions telemetry metadata", () => {
  it("tags crawl-prompt spans with the crawl id", async () => {
    await generateCrawlerOptionsFromPrompt(
      "only the blog",
      noopLogger,
      new CostTracking(),
      { teamId: "test-team", crawlId: "test-crawl" },
    );

    const telemetry = lastCallTelemetry();
    expect(telemetry.functionId).toBe("generateCrawlerOptionsFromPrompt");
    expect(telemetry.metadata).toMatchObject({
      teamId: "test-team",
      crawlId: "test-crawl",
    });
  });

  it("leaves crawlId out when previewing params without a crawl", async () => {
    await generateCrawlerOptionsFromPrompt(
      "only the blog",
      noopLogger,
      new CostTracking(),
      { teamId: "test-team" },
    );

    expect(lastCallTelemetry().metadata).toEqual({
      teamId: "test-team",
    });
  });

  it("keeps tagging scrape spans with the scrape id", async () => {
    await generateCompletions({
      logger: noopLogger,
      options: {},
      markdown: "page",
      costTrackingOptions: { costTracking: new CostTracking(), metadata: {} },
      metadata: { teamId: "test-team", scrapeId: "test-scrape" },
    });

    expect(lastCallTelemetry().metadata).toMatchObject({
      teamId: "test-team",
      scrapeId: "test-scrape",
    });
  });

  it("adds the requesting feature's span metadata without overriding the job ids", async () => {
    await generateCompletions({
      logger: noopLogger,
      options: {},
      markdown: "page",
      costTrackingOptions: { costTracking: new CostTracking(), metadata: {} },
      metadata: {
        teamId: "test-team",
        functionId: "monitor/searchJudge",
        scrapeId: "test-scrape",
        telemetry: {
          teamId: "other-team",
          jobId: "test-check",
          jobKind: "monitor",
          feature: "monitor_search_judge",
        },
      },
    });

    const telemetry = lastCallTelemetry();
    expect(telemetry.functionId).toBe("monitor/searchJudge");
    expect(telemetry.metadata).toMatchObject({
      teamId: "test-team",
      scrapeId: "test-scrape",
      jobId: "test-check",
      jobKind: "monitor",
      feature: "monitor_search_judge",
    });
  });
});
