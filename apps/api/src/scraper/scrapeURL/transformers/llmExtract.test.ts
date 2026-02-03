import { removeDefaultProperty } from "./llmExtract";
import { trimToTokenLimit } from "./llmExtract";
import { performSummary } from "./llmExtract";
import {
  wrapSchemaWithCompletionCheck,
  unwrapCompletionCheckResult,
} from "./llmExtract";
import { encoding_for_model } from "@dqbd/tiktoken";
import {
  countTokens,
  splitContentIntoChunks,
  detectSchemaType,
} from "../../../lib/extract/helpers/chunking";
import {
  aggregateUsage,
  mergeChunkResultsWithLLM,
  ChunkResult,
} from "../../../lib/extract/helpers/chunk-merger";
import { generateObject } from "ai";

jest.mock("@dqbd/tiktoken", () => ({
  encoding_for_model: jest.fn(),
}));

jest.mock("ai", () => ({
  generateObject: jest.fn(),
  jsonSchema: jest.fn(schema => schema),
}));

describe("removeDefaultProperty", () => {
  it("should remove the default property from a simple object", () => {
    const input = { default: "test", test: "test" };
    const expectedOutput = { test: "test" };
    expect(removeDefaultProperty(input)).toEqual(expectedOutput);
  });

  it("should remove the default property from a nested object", () => {
    const input = {
      default: "test",
      nested: { default: "nestedTest", test: "nestedTest" },
    };
    const expectedOutput = { nested: { test: "nestedTest" } };
    expect(removeDefaultProperty(input)).toEqual(expectedOutput);
  });

  it("should remove the default property from an array of objects", () => {
    const input = {
      array: [
        { default: "test1", test: "test1" },
        { default: "test2", test: "test2" },
      ],
    };
    const expectedOutput = { array: [{ test: "test1" }, { test: "test2" }] };
    expect(removeDefaultProperty(input)).toEqual(expectedOutput);
  });

  it("should handle objects without a default property", () => {
    const input = { test: "test" };
    const expectedOutput = { test: "test" };
    expect(removeDefaultProperty(input)).toEqual(expectedOutput);
  });

  it("should handle null and non-object inputs", () => {
    expect(removeDefaultProperty(null)).toBeNull();
    expect(removeDefaultProperty("string")).toBe("string");
    expect(removeDefaultProperty(123)).toBe(123);
  });
});

describe("trimToTokenLimit", () => {
  const mockEncode = jest.fn();
  const mockFree = jest.fn();
  const mockEncoder = {
    encode: mockEncode,
    free: mockFree,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (encoding_for_model as jest.Mock).mockReturnValue(mockEncoder);
  });

  it("should return original text if within token limit", () => {
    const text = "This is a test text";
    mockEncode.mockReturnValue(new Array(5)); // Simulate 5 tokens

    const result = trimToTokenLimit(text, 10, "gpt-4o");

    expect(result).toEqual({
      text,
      numTokens: 5,
      warning: undefined,
    });
    expect(mockEncode).toHaveBeenCalledWith(text);
    expect(mockFree).toHaveBeenCalled();
  });

  it("should trim text and return warning when exceeding token limit", () => {
    const text = "This is a longer text that needs to be trimmed";
    mockEncode
      .mockReturnValueOnce(new Array(20)) // First call for full text
      .mockReturnValueOnce(new Array(8)); // Second call for trimmed text

    const result = trimToTokenLimit(text, 10, "gpt-4o");

    expect(result.text.length).toBeLessThan(text.length);
    expect(result.numTokens).toBe(8);
    expect(result.warning).toContain("automatically trimmed");
    expect(mockEncode).toHaveBeenCalledTimes(2);
    expect(mockFree).toHaveBeenCalled();
  });

  it("should append previous warning if provided", () => {
    const text = "This is a test text that is too long";
    const previousWarning = "Previous warning message";
    mockEncode
      .mockReturnValueOnce(new Array(15))
      .mockReturnValueOnce(new Array(8));

    const result = trimToTokenLimit(text, 10, "gpt-4o", previousWarning);

    expect(result.warning).toContain("automatically trimmed");
    expect(result.warning).toContain(previousWarning);
  });

  it("should use fallback approach when encoder throws error", () => {
    const text = "This is some text to test fallback";
    mockEncode.mockImplementation(() => {
      throw new Error("Encoder error");
    });

    const result = trimToTokenLimit(text, 10, "gpt-4o");

    expect(result.text.length).toBeLessThanOrEqual(30); // 10 tokens * 3 chars per token
    expect(result.numTokens).toBe(10);
    expect(result.warning).toContain("Failed to derive number of LLM tokens");
  });

  it("should handle empty text", () => {
    const text = "";
    mockEncode.mockReturnValue([]);

    const result = trimToTokenLimit(text, 10, "gpt-4o");

    expect(result).toEqual({
      text: "",
      numTokens: 0,
      warning: undefined,
    });
    expect(mockFree).toHaveBeenCalled();
  });

  it("should handle large token limits (128k)", () => {
    const text = "A".repeat(384000); // Assuming ~3 chars per token, this would be ~128k tokens
    mockEncode
      .mockReturnValueOnce(new Array(130000)) // First check shows it's too long
      .mockReturnValueOnce(new Array(127000)); // Second check shows it's within limit after trim

    const result = trimToTokenLimit(text, 128000, "gpt-4o");

    expect(result.text.length).toBeLessThan(text.length);
    expect(result.numTokens).toBe(127000);
    expect(result.warning).toContain("automatically trimmed");
    expect(mockEncode).toHaveBeenCalledTimes(2);
    expect(mockFree).toHaveBeenCalled();
  });

  it("should handle large token limits (512k) with 32k context window", () => {
    const text = "A".repeat(1536000); // Assuming ~3 chars per token, this would be ~512k tokens
    mockEncode
      .mockReturnValueOnce(new Array(520000)) // First check shows it's too long
      .mockReturnValueOnce(new Array(32000)); // Second check shows it's within context limit after trim

    const result = trimToTokenLimit(text, 32000, "gpt-4o");

    expect(result.text.length).toBeLessThan(text.length);
    expect(result.numTokens).toBe(32000);
    expect(result.warning).toContain("automatically trimmed");
    expect(mockEncode).toHaveBeenCalledTimes(2);
    expect(mockFree).toHaveBeenCalled();
  });

  it("should preserve text when under token limit", () => {
    const text = "Short text";
    mockEncode.mockReturnValue(new Array(5)); // 5 tokens

    const result = trimToTokenLimit(text, 10, "gpt-4o");

    expect(result.text).toBe(text);
    expect(result.numTokens).toBe(5);
    expect(result.warning).toBeUndefined();
    expect(mockFree).toHaveBeenCalled();
  });

  it("should append new warning to previous warning", () => {
    const text = "A".repeat(300);
    const previousWarning = "Previous warning message";
    mockEncode
      .mockReturnValueOnce(new Array(100))
      .mockReturnValueOnce(new Array(50));

    const result = trimToTokenLimit(text, 50, "gpt-4o", previousWarning);

    expect(result.warning).toContain("automatically trimmed");
    expect(result.warning).toContain(previousWarning);
    expect(mockFree).toHaveBeenCalled();
  });

  it("should handle encoder initialization failure gracefully", () => {
    const text = "Sample text";
    (encoding_for_model as jest.Mock).mockImplementationOnce(() => {
      throw new Error("Encoder initialization failed");
    });

    const result = trimToTokenLimit(text, 10, "gpt-4o");

    expect(result.text.length).toBeLessThanOrEqual(30); // 10 tokens * 3 chars
    expect(result.warning).toContain("Failed to derive number of LLM tokens");
    expect(mockFree).not.toHaveBeenCalled();
  });

  it("should handle encoding errors during trimming", () => {
    const text = "Sample text";
    mockEncode.mockImplementation(() => {
      throw new Error("Encoding failed");
    });

    const result = trimToTokenLimit(text, 10, "gpt-4o");

    expect(result.text.length).toBeLessThanOrEqual(30);
    expect(result.warning).toContain("Failed to derive number of LLM tokens");
    expect(mockFree).toHaveBeenCalled();
  });

  it("should handle very small token limits", () => {
    const text = "This is a test sentence that should be trimmed significantly";
    mockEncode
      .mockReturnValueOnce(new Array(20))
      .mockReturnValueOnce(new Array(3));

    const result = trimToTokenLimit(text, 3, "gpt-4o");

    expect(result.text.length).toBeLessThan(text.length);
    expect(result.numTokens).toBe(3);
    expect(result.warning).toContain("automatically trimmed");
    expect(mockFree).toHaveBeenCalled();
  });

  it("should handle unicode characters", () => {
    const text = "Hello 👋 World 🌍";
    mockEncode
      .mockReturnValueOnce(new Array(8))
      .mockReturnValueOnce(new Array(4));

    const result = trimToTokenLimit(text, 4, "gpt-4o");

    expect(result.text.length).toBeLessThan(text.length);
    expect(result.numTokens).toBe(4);
    expect(result.warning).toContain("automatically trimmed");
    expect(mockFree).toHaveBeenCalled();
  });

  it("should handle multiple trimming iterations", () => {
    const text = "A".repeat(1000);
    mockEncode
      .mockReturnValueOnce(new Array(300))
      .mockReturnValueOnce(new Array(200))
      .mockReturnValueOnce(new Array(100))
      .mockReturnValueOnce(new Array(50));

    const result = trimToTokenLimit(text, 50, "gpt-4o");

    expect(result.text.length).toBeLessThan(text.length);
    expect(result.numTokens).toBe(50);
    expect(result.warning).toContain("automatically trimmed");
    expect(mockEncode).toHaveBeenCalledTimes(4);
    expect(mockFree).toHaveBeenCalled();
  });

  it("should handle exact token limit match", () => {
    const text = "Exact token limit text";
    mockEncode.mockReturnValue(new Array(10));

    const result = trimToTokenLimit(text, 10, "gpt-4o");

    expect(result.text).toBe(text);
    expect(result.numTokens).toBe(10);
    expect(result.warning).toBeUndefined();
    expect(mockFree).toHaveBeenCalled();
  });
});

describe("performSummary", () => {
  it("should skip summary generation and add warning when markdown is empty", async () => {
    const mockMeta = {
      options: { formats: [{ type: "summary" }] },
      internalOptions: { zeroDataRetention: false, teamId: "test-team" },
      logger: {
        child: jest.fn(() => ({
          info: jest.fn(),
        })),
      },
      costTracking: {},
      id: "test-id",
    } as any;

    const document = {
      markdown: "",
    } as any;

    const result = await performSummary(mockMeta, document);

    expect(result.summary).toBeUndefined();
    expect(result.warning).toContain(
      "Summary generation was skipped because the markdown content is empty",
    );
  });

  it("should skip summary generation when markdown is whitespace-only", async () => {
    const mockMeta = {
      options: { formats: [{ type: "summary" }] },
      internalOptions: { zeroDataRetention: false, teamId: "test-team" },
      logger: {
        child: jest.fn(() => ({
          info: jest.fn(),
        })),
      },
      costTracking: {},
      id: "test-id",
    } as any;

    const document = {
      markdown: "   \n\t  ",
    } as any;

    const result = await performSummary(mockMeta, document);

    expect(result.summary).toBeUndefined();
    expect(result.warning).toContain(
      "Summary generation was skipped because the markdown content is empty",
    );
  });
});

describe("countTokens", () => {
  const mockEncode = jest.fn();
  const mockFree = jest.fn();
  const mockEncoder = {
    encode: mockEncode,
    free: mockFree,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (encoding_for_model as jest.Mock).mockReturnValue(mockEncoder);
  });

  it("should count tokens using tiktoken", () => {
    mockEncode.mockReturnValue(new Array(10));
    const result = countTokens("Hello world", "gpt-4o-mini");
    expect(result).toBe(10);
    expect(mockFree).toHaveBeenCalled();
  });

  it("should fallback to estimation when tiktoken fails", () => {
    (encoding_for_model as jest.Mock).mockImplementation(() => {
      throw new Error("Encoder error");
    });
    const text = "Hello world test"; // 16 chars
    const result = countTokens(text, "gpt-4o-mini");
    // Fallback uses text.length / 2.8
    expect(result).toBe(Math.ceil(16 / 2.8));
  });
});

describe("detectSchemaType", () => {
  it("should detect array schema", () => {
    const schema = { type: "array", items: { type: "object" } };
    expect(detectSchemaType(schema)).toBe("array");
  });

  it("should detect object schema with explicit type", () => {
    const schema = { type: "object", properties: { name: { type: "string" } } };
    expect(detectSchemaType(schema)).toBe("object");
  });

  it("should detect object schema from properties", () => {
    const schema = { properties: { name: { type: "string" } } };
    expect(detectSchemaType(schema)).toBe("object");
  });

  it("should return unknown for null/undefined", () => {
    expect(detectSchemaType(null)).toBe("unknown");
    expect(detectSchemaType(undefined)).toBe("unknown");
  });

  it("should return unknown for unrecognized schema", () => {
    const schema = { anyOf: [{ type: "string" }, { type: "number" }] };
    expect(detectSchemaType(schema)).toBe("unknown");
  });
});

describe("splitContentIntoChunks", () => {
  const mockEncode = jest.fn();
  const mockFree = jest.fn();
  const mockEncoder = {
    encode: mockEncode,
    free: mockFree,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (encoding_for_model as jest.Mock).mockReturnValue(mockEncoder);
  });

  it("should return single chunk if content fits", () => {
    mockEncode.mockReturnValue(new Array(100)); // 100 tokens
    const content = "Short content";
    const chunks = splitContentIntoChunks(content, {
      maxTokensPerChunk: 1000,
      overlapTokens: 100,
      modelId: "gpt-4o-mini",
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe(content);
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[0].totalChunks).toBe(1);
  });

  it("should split content into multiple chunks when exceeding limit", () => {
    // First call: total tokens (high), subsequent calls: chunk tokens
    mockEncode
      .mockReturnValueOnce(new Array(500)) // Total content tokens
      .mockReturnValueOnce(new Array(200)) // First chunk
      .mockReturnValueOnce(new Array(200)) // Second chunk
      .mockReturnValueOnce(new Array(150)); // Third chunk (remaining)

    const content = "A".repeat(1500); // Long content
    const chunks = splitContentIntoChunks(content, {
      maxTokensPerChunk: 200,
      overlapTokens: 50,
      modelId: "gpt-4o-mini",
    });

    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((chunk, i) => {
      expect(chunk.chunkIndex).toBe(i);
      expect(chunk.totalChunks).toBe(chunks.length);
    });
  });

  it("should set correct totalChunks on all chunks", () => {
    mockEncode
      .mockReturnValueOnce(new Array(300))
      .mockReturnValueOnce(new Array(100))
      .mockReturnValueOnce(new Array(100))
      .mockReturnValueOnce(new Array(100));

    const content = "Test content ".repeat(50);
    const chunks = splitContentIntoChunks(content, {
      maxTokensPerChunk: 100,
      overlapTokens: 20,
      modelId: "gpt-4o-mini",
    });

    const totalChunks = chunks.length;
    chunks.forEach(chunk => {
      expect(chunk.totalChunks).toBe(totalChunks);
    });
  });
});

describe("aggregateUsage", () => {
  it("should sum token usage from multiple results", () => {
    const usages = [
      { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      { promptTokens: 200, completionTokens: 100, totalTokens: 300 },
      { promptTokens: 150, completionTokens: 75, totalTokens: 225 },
    ];

    const result = aggregateUsage(usages);

    expect(result.promptTokens).toBe(450);
    expect(result.completionTokens).toBe(225);
    expect(result.totalTokens).toBe(675);
  });

  it("should handle empty array", () => {
    const result = aggregateUsage([]);
    expect(result.promptTokens).toBe(0);
    expect(result.completionTokens).toBe(0);
    expect(result.totalTokens).toBe(0);
  });

  it("should handle single usage", () => {
    const usages = [
      { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    ];
    const result = aggregateUsage(usages);

    expect(result.promptTokens).toBe(100);
    expect(result.completionTokens).toBe(50);
    expect(result.totalTokens).toBe(150);
  });

  it("should handle undefined values", () => {
    const usages = [
      { promptTokens: 100, completionTokens: undefined, totalTokens: 100 },
      { promptTokens: undefined, completionTokens: 50, totalTokens: 50 },
    ] as any;

    const result = aggregateUsage(usages);

    expect(result.promptTokens).toBe(100);
    expect(result.completionTokens).toBe(50);
    expect(result.totalTokens).toBe(150);
  });
});

describe("mergeChunkResultsWithLLM", () => {
  const mockGenerateObject = generateObject as jest.Mock;
  const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as any;
  const mockCostTracking = {
    addCall: jest.fn(),
  };
  const mockCalculateCost = jest.fn(() => 0.001);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should return single result directly without LLM call", async () => {
    const results: ChunkResult[] = [
      {
        chunkIndex: 0,
        extract: { name: "test", value: 123 },
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      },
    ];

    const result = await mergeChunkResultsWithLLM({
      results,
      originalSchema: {
        type: "object",
        properties: { name: { type: "string" } },
      },
      schemaType: "object",
      model: { modelId: "gpt-4o-mini" } as any,
      costTrackingOptions: {
        costTracking: mockCostTracking as any,
        metadata: {},
      },
      metadata: { teamId: "test-team" },
      logger: mockLogger,
      calculateCost: mockCalculateCost,
    });

    expect(result.mergedExtract).toEqual({ name: "test", value: 123 });
    expect(mockGenerateObject).not.toHaveBeenCalled();
  });

  it("should merge array results using LLM", async () => {
    const results: ChunkResult[] = [
      {
        chunkIndex: 0,
        extract: [{ id: 1, name: "Item 1" }],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      },
      {
        chunkIndex: 1,
        extract: [{ id: 2, name: "Item 2" }],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      },
    ];

    mockGenerateObject.mockResolvedValue({
      object: {
        items: [
          { id: 1, name: "Item 1" },
          { id: 2, name: "Item 2" },
        ],
      },
      usage: { inputTokens: 200, outputTokens: 100 },
    });

    const result = await mergeChunkResultsWithLLM({
      results,
      originalSchema: { type: "array", items: { type: "object" } },
      schemaType: "array",
      model: { modelId: "gpt-4o-mini" } as any,
      costTrackingOptions: {
        costTracking: mockCostTracking as any,
        metadata: {},
      },
      metadata: { teamId: "test-team" },
      logger: mockLogger,
      calculateCost: mockCalculateCost,
    });

    expect(mockGenerateObject).toHaveBeenCalled();
    expect(result.mergedExtract).toEqual([
      { id: 1, name: "Item 1" },
      { id: 2, name: "Item 2" },
    ]);
    expect(result.mergeStrategy).toBe("llm_intelligent");
    expect(mockCostTracking.addCall).toHaveBeenCalled();
  });

  it("should merge object results using LLM", async () => {
    const results: ChunkResult[] = [
      {
        chunkIndex: 0,
        extract: { title: "Page Title", description: null },
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      },
      {
        chunkIndex: 1,
        extract: { title: null, description: "Page description here" },
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      },
    ];

    mockGenerateObject.mockResolvedValue({
      object: { title: "Page Title", description: "Page description here" },
      usage: { inputTokens: 200, outputTokens: 100 },
    });

    const result = await mergeChunkResultsWithLLM({
      results,
      originalSchema: {
        type: "object",
        properties: { title: { type: "string" } },
      },
      schemaType: "object",
      model: { modelId: "gpt-4o-mini" } as any,
      costTrackingOptions: {
        costTracking: mockCostTracking as any,
        metadata: {},
      },
      metadata: { teamId: "test-team" },
      logger: mockLogger,
      calculateCost: mockCalculateCost,
    });

    expect(mockGenerateObject).toHaveBeenCalled();
    expect(result.mergedExtract).toEqual({
      title: "Page Title",
      description: "Page description here",
    });
    expect(result.mergeStrategy).toBe("llm_intelligent");
  });

  it("should fallback to simple merge when LLM fails for arrays", async () => {
    const results: ChunkResult[] = [
      {
        chunkIndex: 0,
        extract: [{ id: 1 }],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      },
      {
        chunkIndex: 1,
        extract: [{ id: 2 }],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      },
    ];

    mockGenerateObject.mockRejectedValue(new Error("LLM API error"));

    const result = await mergeChunkResultsWithLLM({
      results,
      originalSchema: { type: "array", items: { type: "object" } },
      schemaType: "array",
      model: { modelId: "gpt-4o-mini" } as any,
      costTrackingOptions: {
        costTracking: mockCostTracking as any,
        metadata: {},
      },
      metadata: { teamId: "test-team" },
      logger: mockLogger,
      calculateCost: mockCalculateCost,
    });

    expect(result.mergeStrategy).toBe("array_concat");
    expect(result.warning).toContain("LLM merge failed");
    expect(result.mergedExtract).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("should fallback to simple merge when LLM fails for objects", async () => {
    const results: ChunkResult[] = [
      {
        chunkIndex: 0,
        extract: { a: 1, b: null },
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      },
      {
        chunkIndex: 1,
        extract: { a: null, b: 2 },
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      },
    ];

    mockGenerateObject.mockRejectedValue(new Error("LLM API error"));

    const result = await mergeChunkResultsWithLLM({
      results,
      originalSchema: { type: "object" },
      schemaType: "object",
      model: { modelId: "gpt-4o-mini" } as any,
      costTrackingOptions: {
        costTracking: mockCostTracking as any,
        metadata: {},
      },
      metadata: { teamId: "test-team" },
      logger: mockLogger,
      calculateCost: mockCalculateCost,
    });

    expect(result.mergeStrategy).toBe("object_merge");
    expect(result.warning).toContain("LLM merge failed");
    expect(result.mergedExtract).toEqual({ a: 1, b: 2 });
  });

  it("should aggregate usage from all chunks plus merge", async () => {
    const results: ChunkResult[] = [
      {
        chunkIndex: 0,
        extract: [{ id: 1 }],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      },
      {
        chunkIndex: 1,
        extract: [{ id: 2 }],
        usage: { promptTokens: 200, completionTokens: 100, totalTokens: 300 },
      },
    ];

    mockGenerateObject.mockResolvedValue({
      object: { items: [{ id: 1 }, { id: 2 }] },
      usage: { inputTokens: 50, outputTokens: 25 },
    });

    const result = await mergeChunkResultsWithLLM({
      results,
      originalSchema: { type: "array" },
      schemaType: "array",
      model: { modelId: "gpt-4o-mini" } as any,
      costTrackingOptions: {
        costTracking: mockCostTracking as any,
        metadata: {},
      },
      metadata: { teamId: "test-team" },
      logger: mockLogger,
      calculateCost: mockCalculateCost,
    });

    // 100 + 200 + 50 = 350 prompt tokens
    // 50 + 100 + 25 = 175 completion tokens
    expect(result.usage.promptTokens).toBe(350);
    expect(result.usage.completionTokens).toBe(175);
  });
});

describe("wrapSchemaWithCompletionCheck", () => {
  it("should wrap a simple object schema with extractionComplete", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
      },
    };

    const wrapped = wrapSchemaWithCompletionCheck(schema);

    expect(wrapped.type).toBe("object");
    expect(wrapped.properties.data).toEqual(schema);
    expect(wrapped.properties.extractionComplete.type).toBe("boolean");
    expect(wrapped.required).toContain("data");
    expect(wrapped.required).toContain("extractionComplete");
    expect(wrapped.additionalProperties).toBe(false);
  });

  it("should wrap an array schema with extractionComplete", () => {
    const schema = {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
        },
      },
    };

    const wrapped = wrapSchemaWithCompletionCheck(schema);

    expect(wrapped.properties.data).toEqual(schema);
    expect(wrapped.properties.extractionComplete).toBeDefined();
  });

  it("should return null/undefined as-is", () => {
    expect(wrapSchemaWithCompletionCheck(null)).toBeNull();
    expect(wrapSchemaWithCompletionCheck(undefined)).toBeUndefined();
  });

  it("should return Zod schemas as-is", () => {
    // Mock Zod type check - in actual test this would be a real Zod schema
    const { z } = jest.requireActual("zod");
    const zodSchema = z.object({ name: z.string() });

    const result = wrapSchemaWithCompletionCheck(zodSchema);

    // Should return the same Zod schema unchanged
    expect(result).toBe(zodSchema);
  });
});

describe("unwrapCompletionCheckResult", () => {
  it("should unwrap a wrapped result with data and extractionComplete", () => {
    const wrappedResult = {
      data: { name: "Test", value: 123 },
      extractionComplete: true,
    };

    const { data, extractionComplete } =
      unwrapCompletionCheckResult(wrappedResult);

    expect(data).toEqual({ name: "Test", value: 123 });
    expect(extractionComplete).toBe(true);
  });

  it("should unwrap a result with incomplete extraction", () => {
    const wrappedResult = {
      data: [{ id: 1 }, { id: 2 }],
      extractionComplete: false,
    };

    const { data, extractionComplete } =
      unwrapCompletionCheckResult(wrappedResult);

    expect(data).toEqual([{ id: 1 }, { id: 2 }]);
    expect(extractionComplete).toBe(false);
  });

  it("should default extractionComplete to true if missing", () => {
    const wrappedResult = {
      data: { name: "Test" },
    };

    const { data, extractionComplete } =
      unwrapCompletionCheckResult(wrappedResult);

    expect(data).toEqual({ name: "Test" });
    expect(extractionComplete).toBe(true);
  });

  it("should return raw result with extractionComplete true for unwrapped data", () => {
    const rawResult = { name: "Test", value: 123 };

    const { data, extractionComplete } = unwrapCompletionCheckResult(rawResult);

    expect(data).toEqual({ name: "Test", value: 123 });
    expect(extractionComplete).toBe(true);
  });

  it("should handle null result", () => {
    const { data, extractionComplete } = unwrapCompletionCheckResult(null);

    expect(data).toBeNull();
    expect(extractionComplete).toBe(true);
  });

  it("should handle array result without wrapper", () => {
    const arrayResult = [{ id: 1 }, { id: 2 }];

    const { data, extractionComplete } =
      unwrapCompletionCheckResult(arrayResult);

    // Array without "data" property should be returned as-is
    expect(data).toEqual([{ id: 1 }, { id: 2 }]);
    expect(extractionComplete).toBe(true);
  });
});
