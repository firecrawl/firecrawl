import { vi } from "vitest";

vi.mock("ai", async importOriginal => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: vi.fn() };
});
vi.mock("../../../lib/generic-ai", () => ({
  getModel: vi.fn((name: string) => ({ modelId: name })),
}));

import { generateText } from "ai";
import type { Mock } from "vitest";
import { performQuery } from "./query";
import { CostTracking } from "../../../lib/cost-tracking";

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

beforeEach(() => {
  (generateText as Mock).mockReset();
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
    const lines = args.prompt
      .split("<lines")[1]
      .split("\n")
      .slice(1, -1) as string[];
    expect(lines.length).toBeLessThan(40_000);
    lines.forEach((line, i) => expect(line).toMatch(new RegExp(`^${i}: `)));
    expect(document.highlights).toContain("Line number 0");
    expect(document.warning).toContain(
      "highlights were generated from the first part of it",
    );
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
    expect(mini.prompt.length).toBeLessThan(markdown.length);
    expect(mini.experimental_telemetry.functionId).toBe(
      "performQuery/freeform",
    );
    expect(document.answer).toBe("the answer");
    expect(document.warning).toContain(
      "the answer was generated from the first part of it",
    );
  });
});
