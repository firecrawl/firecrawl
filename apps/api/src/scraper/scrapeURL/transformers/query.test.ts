import { vi } from "vitest";
import type { generateText as generateTextFn } from "ai";
import type { encoding_for_model as encodingForModelFn } from "@dqbd/tiktoken";
import { MockLanguageModelV3 } from "ai/test";
import { createLogger } from "winston";

type GenerateTextArgs = Parameters<typeof generateTextFn>[0];
type MockGenerateTextResult = {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
};

const mocks = vi.hoisted(() => ({
  generateText:
    vi.fn<(args: GenerateTextArgs) => Promise<MockGenerateTextResult>>(),
  getModel: vi.fn<(name: string, provider?: string) => LlmModel>(),
}));

vi.mock("ai", async importOriginal => {
  const actual = await importOriginal<{
    generateText: typeof generateTextFn;
  }>();
  return { ...actual, generateText: mocks.generateText };
});
vi.mock("@dqbd/tiktoken", async importOriginal => {
  const actual = await importOriginal<{
    encoding_for_model: typeof encodingForModelFn;
  }>();
  return {
    ...actual,
    encoding_for_model: vi.fn(actual.encoding_for_model),
  };
});
vi.mock("../../../lib/generic-ai", () => ({
  getModel: mocks.getModel,
}));

import { encoding_for_model } from "@dqbd/tiktoken";
import { keepWholeLines, performDirectQuoteQuery, performQuery } from "./query";
import type { Meta } from "..";
import type { Document, FormatObject } from "../../../controllers/v2/types";
import {
  applyScrapeOptionsDefaults,
  scrapeOptions,
} from "../../../controllers/v2/types";
import { CostTracking } from "../../../lib/cost-tracking";
import { modelPrices } from "../../../lib/model-prices";
import { AbortManager } from "../lib/abortManager";
import {
  createService,
  replaceService,
  service,
} from "../../../service/service";
import type {
  LlmModel,
  LlmProvider,
  LlmProviderName,
} from "../../../service/llm-providers";

const noopLogger = createLogger({ silent: true });

type TestFormatInput =
  | FormatObject
  | { type: "query"; prompt: string; mode?: "freeform" | "directQuote" };

function makeMeta(formats: Array<TestFormatInput>): Meta {
  const normalizedFormats: Array<FormatObject> = formats.map(f =>
    f.type === "query" ? { ...f, mode: f.mode ?? "freeform" } : f,
  );
  return {
    id: "scrape-id",
    url: "https://example.com",
    ctx: { teamId: "test-team", zeroDataRetention: false },
    state: {},
    options: {
      ...applyScrapeOptionsDefaults(scrapeOptions.parse({})),
      formats: normalizedFormats,
    },
    internalOptions: {
      teamId: "test-team",
      orgId: null,
      zeroDataRetention: false,
    },
    logger: noopLogger,
    abort: new AbortManager(),
    featureFlags: new Set(),
    mock: null,
    imageOcrEnabled: async () => false,
    pdfPrefetch: undefined,
    documentPrefetch: undefined,
    imagePrefetch: undefined,
    fetchPrefetch: undefined,
    costTracking: new CostTracking(),
    threatDecisions: [],
  };
}

function makeDocument(markdown: string): Document {
  return {
    markdown,
    metadata: { statusCode: 200, proxyUsed: "basic" },
  };
}

function calls(): Array<GenerateTextArgs> {
  return mocks.generateText.mock.calls.map(([args]) => args);
}

function modelIdOf(model: GenerateTextArgs["model"]): string {
  return typeof model === "string" ? model : model.modelId;
}

function stringPrompt(prompt: GenerateTextArgs["prompt"]): string {
  if (typeof prompt !== "string") {
    throw new Error("Expected string prompt");
  }
  return prompt;
}

function respond(text: string) {
  mocks.generateText.mockResolvedValueOnce({
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
function sentLines(prompt: GenerateTextArgs["prompt"]): Array<string> {
  return stringPrompt(prompt).split("<lines")[1].split("\n").slice(1, -1);
}

let realEncodingForModel: typeof encoding_for_model;

beforeAll(async () => {
  ({ encoding_for_model: realEncodingForModel } = await vi.importActual<{
    encoding_for_model: typeof encodingForModelFn;
  }>("@dqbd/tiktoken"));
});

function isExtensionProviderName(name: string): name is LlmProviderName {
  return name.length > 0;
}

const stubProvider = (name: string, enabled: () => boolean): LlmProvider => {
  if (!isExtensionProviderName(name)) {
    throw new Error("Provider name must be non-empty");
  }
  return {
    name,
    enabled,
    model: (id: string): LlmModel => new MockLanguageModelV3({ modelId: id }),
  };
};

let vertexEnabled = false;

beforeEach(() => {
  vertexEnabled = false;
  replaceService(
    createService(
      {
        modules: {},
        extensions: [
          {
            name: "extra-llm",
            llmProviders: [
              stubProvider("vertex", () => vertexEnabled),
              stubProvider("google", () => true),
              stubProvider("fireworks", () => true),
            ],
          },
        ],
      },
      {
        core: {
          name: "core",
          llmProviders: [
            stubProvider("openai", () => true),
            stubProvider("ollama", () => false),
          ],
        },
        logger: { error: vi.fn() },
      },
    ),
  );
  mocks.generateText.mockReset();
  mocks.getModel
    .mockReset()
    .mockImplementation(
      (name: string) => new MockLanguageModelV3({ modelId: name }),
    );
  vi.mocked(encoding_for_model)
    .mockReset()
    .mockImplementation(realEncodingForModel);
});

afterEach(() => {
  replaceService(undefined);
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

describe("performDirectQuoteQuery highlights", () => {
  it("keeps whole lines within the model's context window", async () => {
    respond("[0]");
    const markdown = page(40_000);
    const document = makeDocument(markdown);

    const highlights = await performDirectQuoteQuery(
      makeMeta([]),
      document,
      "what does line 0 say?",
      markdown,
      "highlights",
    );

    const [args] = calls();
    expect(args.telemetry?.functionId).toBe("performQuery/highlights");
    const lines = sentLines(args.prompt);
    expect(lines.length).toBeLessThan(40_000);
    lines.forEach((line, i) =>
      expect(line).toBe(`${i}: Line number ${i} says something short.`),
    );
    const tokens = countTokens(lines.join("\n"));
    expect(tokens).toBeLessThanOrEqual(131_072 - 16_384);
    expect(tokens).toBeGreaterThan(131_072 - 16_384 - 100);
    expect(highlights).toContain("Line number 0");
    expect(document.warning).toContain(
      "highlights were generated from the first part of it",
    );
  });

  it("keeps part of a single sentence longer than the window", async () => {
    respond("[0]");
    // One sentence (no punctuation), ~300k tokens.
    const markdown = "word ".repeat(300_000);
    const document = makeDocument(markdown);

    await performDirectQuoteQuery(
      makeMeta([]),
      document,
      "anything about words?",
      markdown,
      "highlights",
    );

    const lines = sentLines(calls()[0].prompt);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^0: word word/);
    expect(countTokens(lines[0])).toBeLessThanOrEqual(131_072 - 16_384);
  });

  it("trims by bytes when the tokenizer fails", async () => {
    vi.mocked(encoding_for_model).mockImplementationOnce(() => {
      throw new Error("tokenizer unavailable");
    });
    respond("[0]");
    const markdown = page(40_000);
    const document = makeDocument(markdown);

    const highlights = await performDirectQuoteQuery(
      makeMeta([]),
      document,
      "what does line 0 say?",
      markdown,
      "highlights",
    );

    const lines = sentLines(calls()[0].prompt);
    lines.forEach((line, i) =>
      expect(line).toBe(`${i}: Line number ${i} says something short.`),
    );
    // The byte cut keeps everything up to the last whole line.
    const bytes = Buffer.byteLength(lines.join("\n"));
    expect(bytes).toBeLessThanOrEqual(131_072 - 16_384);
    expect(bytes).toBeGreaterThan(131_072 - 16_384 - 100);
    expect(highlights).toContain("Line number 0");
  });

  it("sends small pages untouched", async () => {
    respond("[1]");
    const document = makeDocument(page(3));

    await performQuery(
      makeMeta([
        { type: "query", prompt: "what does line 1 say?", mode: "directQuote" },
      ]),
      document,
    );

    const [args] = calls();
    expect(args.telemetry?.functionId).toBe("performQuery/directQuote");
    expect(args.prompt).toContain("2: Line number 2");
    expect(document.warning).toBeUndefined();
  });

  it("trims long pages through performQuery and populates answer and warning", async () => {
    respond("[0]");
    const document = makeDocument(page(40_000));

    await performQuery(
      makeMeta([
        { type: "query", prompt: "what does line 0 say?", mode: "directQuote" },
      ]),
      document,
    );

    const [args] = calls();
    expect(args.telemetry?.functionId).toBe("performQuery/directQuote");
    expect(sentLines(args.prompt).length).toBeLessThan(40_000);
    expect(document.answer).toContain("Line number 0");
    expect(document.warning).toContain(
      "answer was generated from the first part of it",
    );
  });
});

describe("performQuery freeform", () => {
  it("trims the page separately for a smaller-window fallback model", async () => {
    mocks.generateText.mockRejectedValueOnce(new Error("unavailable"));
    respond("the answer");
    // ~180k tokens: fits Gemini's window, not gpt-4o-mini's.
    const markdown = "lorem ipsum dolor sit amet ".repeat(36_000);
    const document = makeDocument(markdown);

    await performQuery(
      makeMeta([{ type: "query", prompt: "what is this?" }]),
      document,
    );

    const [gemini, mini] = calls();
    expect(modelIdOf(gemini.model)).toBe("gemini-3.5-flash-lite");
    expect(gemini.providerOptions).toEqual({
      google: { thinkingConfig: { thinkingLevel: "minimal" } },
    });
    expect(gemini.prompt).toContain(markdown);
    expect(modelIdOf(mini.model)).toBe("gpt-4o-mini");
    // The page is trimmed to exactly 80% of gpt-4o-mini's window; the rest of
    // the prompt is a few tags.
    const budget = Math.floor(
      modelPrices["gpt-4o-mini"].max_input_tokens * 0.8,
    );
    const miniTokens = countTokens(stringPrompt(mini.prompt));
    expect(miniTokens).toBeLessThanOrEqual(budget + 100);
    expect(miniTokens).toBeGreaterThan(budget - 100);
    expect(mini.telemetry?.functionId).toBe("performQuery/freeform");
    expect(document.answer).toBe("the answer");
    expect(document.warning).toContain(
      "the answer was generated from the first part of it",
    );
  });

  it("picks vertex when the registered vertex provider is enabled, otherwise google", async () => {
    respond("from google");
    const docGoogle = makeDocument("hello");
    await performQuery(makeMeta([{ type: "query", prompt: "hi" }]), docGoogle);
    expect(mocks.getModel.mock.calls[0]).toEqual([
      "gemini-3.5-flash-lite",
      "google",
    ]);

    mocks.getModel.mockClear();
    vertexEnabled = true;
    respond("from vertex");
    const docVertex = makeDocument("hello");
    await performQuery(makeMeta([{ type: "query", prompt: "hi" }]), docVertex);
    expect(mocks.getModel.mock.calls[0]).toEqual([
      "gemini-3.5-flash-lite",
      "vertex",
    ]);
  });

  it("uses openai directly when only core LLM providers are registered", async () => {
    replaceService(
      createService(
        { modules: {} },
        {
          core: {
            name: "core",
            llmProviders: [
              stubProvider("openai", () => true),
              stubProvider("ollama", () => false),
            ],
          },
          logger: { error: vi.fn() },
        },
      ),
    );

    respond("from openai");
    const doc = makeDocument("hello");
    await performQuery(makeMeta([{ type: "query", prompt: "hi" }]), doc);

    expect(mocks.getModel.mock.calls).toEqual([["gpt-4o-mini", "openai"]]);
    expect(doc.answer).toBe("from openai");
  });

  it("skips disabled google and vertex providers in freeform mode", async () => {
    replaceService(
      createService(
        {
          modules: {},
          extensions: [
            {
              name: "extra-llm",
              llmProviders: [
                stubProvider("vertex", () => false),
                stubProvider("google", () => false),
              ],
            },
          ],
        },
        {
          core: {
            name: "core",
            llmProviders: [
              stubProvider("openai", () => true),
              stubProvider("ollama", () => false),
            ],
          },
          logger: { error: vi.fn() },
        },
      ),
    );

    respond("from openai");
    const doc = makeDocument("hello");
    await performQuery(makeMeta([{ type: "query", prompt: "hi" }]), doc);

    expect(mocks.getModel.mock.calls).toEqual([["gpt-4o-mini", "openai"]]);
    expect(doc.answer).toBe("from openai");
  });

  it("uses ollama in freeform mode when ollama is enabled and optional providers are absent", async () => {
    replaceService(
      createService(
        { modules: {} },
        {
          core: {
            name: "core",
            llmProviders: [
              stubProvider("openai", () => false),
              stubProvider("ollama", () => true),
            ],
          },
          logger: { error: vi.fn() },
        },
      ),
    );

    respond("from ollama");
    const doc = makeDocument("hello");
    await performQuery(makeMeta([{ type: "query", prompt: "hi" }]), doc);

    expect(mocks.getModel.mock.calls).toEqual([["gpt-4o-mini", "ollama"]]);
    expect(doc.answer).toBe("from ollama");
  });

  it("falls back to the default core provider in directQuote/highlights when fireworks is unregistered", async () => {
    replaceService(
      createService(
        { modules: {} },
        {
          core: {
            name: "core",
            llmProviders: [
              stubProvider("openai", () => true),
              stubProvider("ollama", () => false),
            ],
          },
          logger: { error: vi.fn() },
        },
      ),
    );

    respond("[0]");
    const markdown = "hello world.";
    const doc = makeDocument(markdown);
    const highlights = await performDirectQuoteQuery(
      makeMeta([]),
      doc,
      "what does it say?",
      markdown,
      "highlights",
    );

    expect(mocks.getModel.mock.calls).toEqual([["gpt-4o-mini", "openai"]]);
    expect(highlights).toBe("hello world.");
  });

  it("sets a warning instead of throwing when no matching provider is registered", async () => {
    replaceService(
      createService(
        { modules: {} },
        {
          core: {
            name: "core",
            llmProviders: [],
          },
          logger: { error: vi.fn() },
        },
      ),
    );
    mocks.getModel.mockImplementationOnce((name: string, provider?: string) => {
      const providerName = provider ?? "openai";
      const registered = service.llmProviders.get(providerName);
      if (!registered) {
        throw new Error(`LLM provider "${providerName}" is not registered`);
      }
      return registered.model(name);
    });

    const doc = makeDocument("hello world.");
    await performQuery(
      makeMeta([
        { type: "query", prompt: "what does it say?", mode: "directQuote" },
      ]),
      doc,
    );

    expect(doc.answer).toBeUndefined();
    expect(doc.warning).toContain("Query generation failed after all models.");
  });
});
