import { removeDefaultProperty } from "./llmExtract";
import { trimToTokenLimit } from "./llmExtract";
import { performSummary } from "./llmExtract";
import { performCleanContent } from "./llmExtract";
import { encoding_for_model } from "@dqbd/tiktoken";
import type { Mock } from "vitest";

vi.mock("@dqbd/tiktoken", () => ({
  encoding_for_model: vi.fn(),
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
  // Exercise the real tiktoken encoder/decoder rather than a mock. The function's
  // correctness (and the event-loop-freeze regression it guards against) depends on
  // the real encode -> slice -> decode round-trip, which a hand-rolled mock cannot
  // model faithfully.
  let realEncodingForModel: typeof import("@dqbd/tiktoken").encoding_for_model;

  beforeAll(async () => {
    ({ encoding_for_model: realEncodingForModel } =
      await vi.importActual<typeof import("@dqbd/tiktoken")>("@dqbd/tiktoken"));
  });

  // Records the length of every string handed to encode(), so we can prove the
  // synchronous tokenizer never has to chew through an unbounded input.
  let encodeInputLengths: number[];
  let freeCalls: number;

  beforeEach(() => {
    vi.clearAllMocks();
    encodeInputLengths = [];
    freeCalls = 0;
    (encoding_for_model as Mock).mockImplementation((model: any) => {
      const encoder = realEncodingForModel(model);
      const realEncode = encoder.encode.bind(encoder);
      const realFree = encoder.free.bind(encoder);
      encoder.encode = ((input: string) => {
        encodeInputLengths.push(input.length);
        return realEncode(input);
      }) as typeof encoder.encode;
      encoder.free = (() => {
        freeCalls++;
        return realFree();
      }) as typeof encoder.free;
      return encoder;
    });
  });

  it("should return original text untouched if within token limit", () => {
    const text = "This is a test text";

    const result = trimToTokenLimit(text, 1000, "gpt-4o");

    expect(result.text).toBe(text);
    expect(result.numTokens).toBeGreaterThan(0);
    expect(result.numTokens).toBeLessThanOrEqual(1000);
    expect(result.warning).toBeUndefined();
    expect(freeCalls).toBe(1);
  });

  it("should trim to exactly maxTokens and return a byte-exact prefix", () => {
    const text = "The quick brown fox jumps over the lazy dog. ".repeat(100);
    const maxTokens = 50;

    const result = trimToTokenLimit(text, maxTokens, "gpt-4o");

    expect(result.numTokens).toBe(maxTokens);
    expect(result.warning).toContain("automatically trimmed");
    // ASCII content round-trips exactly, so the result must be a clean prefix.
    expect(text.startsWith(result.text)).toBe(true);
    expect(result.text.length).toBeLessThan(text.length);
    expect(freeCalls).toBe(1);
  });

  it("should append previous warning if provided", () => {
    const text = "This is a test text that is definitely too long. ".repeat(
      100,
    );
    const previousWarning = "Previous warning message";

    const result = trimToTokenLimit(text, 20, "gpt-4o", previousWarning);

    expect(result.warning).toContain("automatically trimmed");
    expect(result.warning).toContain(previousWarning);
  });

  it("should encode only a bounded amount of a huge input (freeze regression)", () => {
    // Before the fix, this synchronously tokenized the entire multi-megabyte
    // string (and re-encoded it in a loop), blocking the event loop for tens of
    // seconds. The pre-trim must cap how much text the encoder ever sees.
    const maxTokens = 1000;
    const huge = "A".repeat(10_000_000);

    const start = Date.now();
    const result = trimToTokenLimit(huge, maxTokens, "gpt-4o");
    const durationMs = Date.now() - start;

    // The encoder must never be handed more than the char-bounded candidate.
    expect(Math.max(...encodeInputLengths)).toBeLessThanOrEqual(maxTokens * 5);
    expect(result.numTokens).toBeLessThanOrEqual(maxTokens);
    expect(result.text.length).toBeLessThanOrEqual(maxTokens * 5);
    expect(result.warning).toBeDefined();
    // Generous threshold: bounded tokenization should complete near-instantly.
    expect(durationMs).toBeLessThan(2000);
    expect(freeCalls).toBe(1);
  });

  it("should use fallback approach when encoder initialization throws", () => {
    const text = "This is some text to test fallback";
    (encoding_for_model as Mock).mockImplementationOnce(() => {
      throw new Error("Encoder error");
    });

    const result = trimToTokenLimit(text, 10, "gpt-4o");

    expect(result.text.length).toBeLessThanOrEqual(Math.floor(10 * 2.8));
    expect(result.numTokens).toBe(10);
    expect(result.warning).toContain("Failed to derive number of LLM tokens");
  });

  it("should handle empty text", () => {
    const result = trimToTokenLimit("", 10, "gpt-4o");

    expect(result.text).toBe("");
    expect(result.numTokens).toBe(0);
    expect(result.warning).toBeUndefined();
    expect(freeCalls).toBe(1);
  });

  it("should not crash on unicode and stay within the token budget", () => {
    const text = "Hello 👋 World 🌍 ".repeat(500);
    const maxTokens = 5;

    const result = trimToTokenLimit(text, maxTokens, "gpt-4o");

    expect(typeof result.text).toBe("string");
    expect(result.numTokens).toBeLessThanOrEqual(maxTokens);
    expect(result.warning).toContain("automatically trimmed");
    expect(freeCalls).toBe(1);
  });

  it("should pre-trim by characters even when the result fits the token budget", () => {
    // Repeated single characters tokenize into far fewer tokens than characters,
    // so a char-pre-trimmed candidate can already be under maxTokens.
    const maxTokens = 100;
    const text = "A".repeat(maxTokens * 5 * 4); // well past the char cap

    const result = trimToTokenLimit(text, maxTokens, "gpt-4o");

    expect(result.text.length).toBeLessThanOrEqual(maxTokens * 5);
    expect(result.text.length).toBeLessThan(text.length);
    expect(result.numTokens).toBeLessThanOrEqual(maxTokens);
    expect(result.warning).toContain("automatically trimmed");
  });
});

describe("performSummary", () => {
  it("should skip summary generation and add warning when markdown is empty", async () => {
    const mockMeta = {
      options: { formats: [{ type: "summary" }] },
      internalOptions: { zeroDataRetention: false, teamId: "test-team" },
      logger: {
        child: vi.fn(() => ({
          info: vi.fn(),
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
        child: vi.fn(() => ({
          info: vi.fn(),
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

describe("performCleanContent", () => {
  const mockEncode = vi.fn();
  const mockFree = vi.fn();
  const mockEncoder = {
    encode: mockEncode,
    free: mockFree,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (encoding_for_model as Mock).mockReturnValue(mockEncoder);
  });

  const makeMeta = (onlyCleanContent: boolean) =>
    ({
      options: { onlyCleanContent },
      internalOptions: { zeroDataRetention: false, teamId: "test-team" },
      logger: {
        child: vi.fn(() => ({ info: vi.fn() })),
        info: vi.fn(),
      },
      costTracking: {},
      id: "test-id",
    }) as any;

  it("should skip cleaning when input tokens exceed model max output tokens", async () => {
    const longMarkdown = "A".repeat(200000); // simulate a very long document
    // Simulate 80,000 tokens — well above gpt-4o-mini's 16,384 output limit
    mockEncode.mockReturnValue(new Array(80000));

    const document = { markdown: longMarkdown } as any;
    const result = await performCleanContent(makeMeta(true), document);

    // Should preserve original markdown
    expect(result.markdown).toBe(longMarkdown);
    // Should have a warning about skipping
    expect(result.warning).toContain("Content cleaning was skipped");
    expect(result.warning).toContain("too long");
    expect(result.warning).toContain("80000 tokens");
    expect(result.warning).toContain("original markdown has been preserved");
  });

  it("should not skip cleaning when input tokens are within model output limit", async () => {
    // Simulate 5,000 tokens — well within gpt-4o-mini's 16,384 output limit
    mockEncode.mockReturnValue(new Array(5000));

    const document = { markdown: "Short content for cleaning" } as any;

    // Track whether logger.child was called with the generateCompletions method,
    // which only happens after the guard passes (line 1180 in llmExtract.ts).
    const childLogger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
    const loggerChild = vi.fn(() => childLogger);
    const meta = {
      options: { onlyCleanContent: true },
      internalOptions: { zeroDataRetention: false, teamId: "test-team" },
      logger: {
        child: loggerChild,
        info: vi.fn(),
        error: vi.fn(),
      },
      costTracking: {},
      id: "test-id",
    } as any;

    // The call will fail inside generateCompletions (no LLM provider configured),
    // but if it gets that far, it proves the guard didn't fire.
    try {
      await performCleanContent(meta, document);
    } catch (_e) {
      // Expected — no LLM available in test
    }

    // Verify the guard did NOT skip: logger.child should have been called with
    // the generateCompletions method, which only happens after the guard.
    expect(loggerChild).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "performCleanContent/generateCompletions",
      }),
    );
    expect(document.warning ?? "").not.toContain(
      "Content cleaning was skipped because the content is too long",
    );
  });

  it("should return document unchanged when onlyCleanContent is false", async () => {
    const document = { markdown: "Some content" } as any;
    const result = await performCleanContent(makeMeta(false), document);

    expect(result.markdown).toBe("Some content");
    expect(result.warning).toBeUndefined();
  });
});
