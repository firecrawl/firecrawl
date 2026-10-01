import { vi } from "vitest";

vi.mock("ai", async importOriginal => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: vi.fn() };
});
vi.mock("@dqbd/tiktoken", async importOriginal => {
  const actual = await importOriginal<typeof import("@dqbd/tiktoken")>();
  return {
    ...actual,
    encoding_for_model: vi.fn(actual.encoding_for_model),
  };
});
vi.mock("../../../lib/generic-ai", () => ({
  getModel: vi.fn((name: string) => ({ modelId: name })),
}));

import { generateText } from "ai";
import { encoding_for_model } from "@dqbd/tiktoken";
import type { Mock } from "vitest";
import { keepWholeLines, performQuery } from "./query";
import { CostTracking } from "../../../lib/cost-tracking";
import { modelPrices } from "../../../lib/extract/usage/model-prices";

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as any;

function makeMeta(formats: any[]) {
  return {
    id: "scrape-id",
    url: "https://example.com",
    options: { formats },
    internalOptions: { teamId: "test-team", zeroDataRetention: false },
    logger: noopLogger,
    costTracking: new CostTracking(),
  } as any;
}

function calls() {
  return (generateText as Mock).mock.calls.map(([args]) => args);
}

function respond(text: string) {
  (generateText as Mock).mockResolvedValueOnce({
    text,
    usage: { inputTokens: 1, outputTokens: 1 },
  });
}

// One sentence per line; roughly 9 tokens per line.
function page(lines: number): string {
  return Array.from(
    { length: lines },
    (_, i) => `Line number ${i} says something short.`,
  ).join("\n\n");
}

function countTokens(text: string): number {
  const encoder = encoding_for_model("gpt-4o");
  try {
    return encoder.encode(text).length;
  } finally {
    encoder.free();
  }
}

// The numbered lines sent to the directQuote model.
function sentLines(prompt: string): string[] {
  return prompt.split("<lines")[1].split("\n").slice(1, -1);
}

let realEncodingForModel: typeof encoding_for_model;

beforeAll(async () => {
  ({ encoding_for_model: realEncodingForModel } =
    await vi.importActual<typeof import("@dqbd/tiktoken")>("@dqbd/tiktoken"));
});

beforeEach(() => {
  (generateText as Mock).mockReset();
  (encoding_for_model as Mock)
    .mockReset()
    .mockImplementation(realEncodingForModel);
});

describe("keepWholeLines", () => {
  const text = "0: first\n1: second\n2: third";

  it("drops a partial last line", () => {
    expect(keepWholeLines(text, "0: first\n1: sec")).toBe("0: first");
  });

  it("keeps a last line the cut ends exactly at", () => {
    expect(keepWholeLines(text, "0: first\n1: second")).toBe(
      "0: first\n1: second",
    );
    expect(keepWholeLines(text, "0: first\n")).toBe("0: first");
  });

  it("keeps a single line longer than the budget, cut short", () => {
    expect(keepWholeLines("0: one very long line", "0: one very")).toBe(
      "0: one very",
    );
  });
});

describe("performQuery highlights", () => {
  it("keeps whole lines within the model's context window", async () => {
    respond("[0]");
    const document: any = { markdown: page(40_000), metadata: {} };

    await performQuery(
      makeMeta([{ type: "highlights", query: "what does line 0 say?" }]),
      document,
    );

    const [args] = calls();
    expect(args.experimental_telemetry.functionId).toBe(
      "performQuery/highlights",
    );
    const lines = sentLines(args.prompt);
    expect(lines.length).toBeLessThan(40_000);
    lines.forEach((line, i) =>
      expect(line).toBe(`${i}: Line number ${i} says something short.`),
    );
    const tokens = countTokens(lines.join("\n"));
    expect(tokens).toBeLessThanOrEqual(131_072 - 16_384);
    expect(tokens).toBeGreaterThan(131_072 - 16_384 - 100);
    expect(document.highlights).toContain("Line number 0");
    expect(document.warning).toContain(
      "highlights were generated from the first part of it",
    );
  });

  it("keeps part of a single sentence longer than the window", async () => {
    respond("[0]");
    // One sentence (no punctuation), ~300k tokens.
    const document: any = { markdown: "word ".repeat(300_000), metadata: {} };

    await performQuery(
      makeMeta([{ type: "highlights", query: "anything about words?" }]),
      document,
    );

    const lines = sentLines(calls()[0].prompt);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^0: word word/);
    expect(countTokens(lines[0])).toBeLessThanOrEqual(131_072 - 16_384);
  });

  it("trims by bytes when the tokenizer fails", async () => {
    (encoding_for_model as Mock).mockImplementationOnce(() => {
      throw new Error("tokenizer unavailable");
    });
    respond("[0]");
    const document: any = { markdown: page(40_000), metadata: {} };

    await performQuery(
      makeMeta([{ type: "highlights", query: "what does line 0 say?" }]),
      document,
    );

    const lines = sentLines(calls()[0].prompt);
    lines.forEach((line, i) =>
      expect(line).toBe(`${i}: Line number ${i} says something short.`),
    );
    // The byte cut keeps everything up to the last whole line.
    const bytes = Buffer.byteLength(lines.join("\n"));
    expect(bytes).toBeLessThanOrEqual(131_072 - 16_384);
    expect(bytes).toBeGreaterThan(131_072 - 16_384 - 100);
    expect(document.highlights).toContain("Line number 0");
  });

  it("sends small pages untouched", async () => {
    respond("[1]");
    const document: any = { markdown: page(3), metadata: {} };

    await performQuery(
      makeMeta([
        { type: "query", prompt: "what does line 1 say?", mode: "directQuote" },
      ]),
      document,
    );

    const [args] = calls();
    expect(args.experimental_telemetry.functionId).toBe(
      "performQuery/directQuote",
    );
    expect(args.prompt).toContain("2: Line number 2");
    expect(document.warning).toBeUndefined();
  });
});

describe("performQuery freeform", () => {
  it("trims the page separately for a smaller-window fallback model", async () => {
    (generateText as Mock).mockRejectedValueOnce(new Error("unavailable"));
    respond("the answer");
    // ~180k tokens: fits Gemini's window, not gpt-4o-mini's.
    const markdown = "lorem ipsum dolor sit amet ".repeat(36_000);
    const document: any = { markdown, metadata: {} };

    await performQuery(
      makeMeta([{ type: "query", prompt: "what is this?" }]),
      document,
    );

    const [gemini, mini] = calls();
    expect(gemini.model.modelId).toBe("gemini-2.5-flash-lite");
    expect(gemini.prompt).toContain(markdown);
    expect(mini.model.modelId).toBe("gpt-4o-mini");
    // The page is trimmed to exactly 80% of gpt-4o-mini's window; the rest of
    // the prompt is a few tags.
    const budget = Math.floor(
      modelPrices["gpt-4o-mini"].max_input_tokens * 0.8,
    );
    const miniTokens = countTokens(mini.prompt);
    expect(miniTokens).toBeLessThanOrEqual(budget + 100);
    expect(miniTokens).toBeGreaterThan(budget - 100);
    expect(mini.experimental_telemetry.functionId).toBe(
      "performQuery/freeform",
    );
    expect(document.answer).toBe("the answer");
    expect(document.warning).toContain(
      "the answer was generated from the first part of it",
    );
  });
});
