import type { Mock } from "vitest";
import { trimToTokenLimit_F0 } from "./llmExtract-f0";
import { encoding_for_model } from "@dqbd/tiktoken";

vi.mock("@dqbd/tiktoken", () => ({
  encoding_for_model: vi.fn(),
}));

describe("trimToTokenLimit_F0", () => {
  // Exercise the real tiktoken encoder/decoder rather than a mock, so the
  // encode -> slice -> decode round-trip (and the freeze regression it guards
  // against) is tested faithfully.
  let realEncodingForModel: typeof import("@dqbd/tiktoken").encoding_for_model;

  beforeAll(async () => {
    ({ encoding_for_model: realEncodingForModel } =
      await vi.importActual<typeof import("@dqbd/tiktoken")>("@dqbd/tiktoken"));
  });

  // Records the length of every string handed to encode(), so we can prove the
  // synchronous tokenizer never has to chew through an unbounded input.
  let encodeInputLengths: number[];

  beforeEach(() => {
    vi.clearAllMocks();
    encodeInputLengths = [];
    (encoding_for_model as Mock).mockImplementation((model: any) => {
      const encoder = realEncodingForModel(model);
      const realEncode = encoder.encode.bind(encoder);
      encoder.encode = ((input: string) => {
        encodeInputLengths.push(input.length);
        return realEncode(input);
      }) as typeof encoder.encode;
      return encoder;
    });
  });

  it("returns the original text untouched when within the token limit", () => {
    const text = "This is a short piece of text";

    const result = trimToTokenLimit_F0(text, 1000, "gpt-4o");

    expect(result.text).toBe(text);
    expect(result.numTokens).toBeGreaterThan(0);
    expect(result.numTokens).toBeLessThanOrEqual(1000);
    expect(result.warning).toBeUndefined();
  });

  it("trims to exactly maxTokens and returns a byte-exact prefix", () => {
    const text = "The quick brown fox jumps over the lazy dog. ".repeat(100);
    const maxTokens = 50;

    const result = trimToTokenLimit_F0(text, maxTokens, "gpt-4o");

    expect(result.numTokens).toBe(maxTokens);
    expect(result.warning).toContain("automatically trimmed");
    // ASCII content round-trips exactly, so the result must be a clean prefix.
    expect(text.startsWith(result.text)).toBe(true);
    expect(result.text.length).toBeLessThan(text.length);
  });

  it("encodes only a bounded amount of a huge input (freeze regression)", () => {
    // Before the fix, this synchronously tokenized the entire multi-megabyte
    // string (and re-encoded it in a loop), blocking the event loop for tens of
    // seconds. The pre-trim must cap how much text the encoder ever sees.
    const maxTokens = 1000;
    const huge = "A".repeat(10_000_000);

    const start = Date.now();
    const result = trimToTokenLimit_F0(huge, maxTokens, "gpt-4o");
    const durationMs = Date.now() - start;

    expect(Math.max(...encodeInputLengths)).toBeLessThanOrEqual(maxTokens * 5);
    expect(result.numTokens).toBeLessThanOrEqual(maxTokens);
    expect(result.text.length).toBeLessThanOrEqual(maxTokens * 5);
    expect(result.warning).toBeDefined();
    expect(durationMs).toBeLessThan(2000);
  });

  it("falls back to a char-based estimate when the encoder throws", () => {
    const text = "This is some text to test fallback";
    (encoding_for_model as Mock).mockImplementationOnce(() => {
      throw new Error("Encoder error");
    });

    const result = trimToTokenLimit_F0(text, 10, "gpt-4o");

    expect(result.text.length).toBeLessThanOrEqual(Math.floor(10 * 2.8));
    expect(result.numTokens).toBe(10);
    expect(result.warning).toContain("Failed to derive number of LLM tokens");
  });

  it("handles empty text", () => {
    const result = trimToTokenLimit_F0("", 10, "gpt-4o");

    expect(result.text).toBe("");
    expect(result.numTokens).toBe(0);
    expect(result.warning).toBeUndefined();
  });
});
