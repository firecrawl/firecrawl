import { vi, describe, it, expect } from "vitest";

// A callable provider stub (AI SDK providers are callable: provider("model-id")
// is shorthand for provider.chat("model-id")) with .chat/.embedding methods.
const { createOpenRouterMock } = vi.hoisted(() => {
  const makeProvider = () => {
    const chat = vi.fn((id: string) => ({ id }));
    const embedding = vi.fn((id: string) => ({ id }));
    const provider: any = vi.fn((id: string) => chat(id));
    provider.chat = chat;
    provider.embedding = embedding;
    return provider;
  };
  return { createOpenRouterMock: vi.fn((_opts: unknown) => makeProvider()) };
});

// generic-ai.ts instantiates every provider at module load; stub them all so
// the orcarouter wiring can be asserted in isolation.
vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: vi.fn(() => ({ chat: vi.fn(), embedding: vi.fn() })),
}));
vi.mock("ollama-ai-provider-v2", () => ({
  createOllama: vi.fn(() => ({ chat: vi.fn(), embedding: vi.fn() })),
}));
vi.mock("@ai-sdk/anthropic", () => ({
  anthropic: { chat: vi.fn(), embedding: vi.fn() },
}));
vi.mock("@ai-sdk/groq", () => ({
  groq: { chat: vi.fn(), embedding: vi.fn() },
}));
vi.mock("@ai-sdk/google", () => ({
  google: { chat: vi.fn(), embedding: vi.fn() },
}));
vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: createOpenRouterMock,
}));
vi.mock("@ai-sdk/fireworks", () => ({
  fireworks: { chat: vi.fn(), embedding: vi.fn() },
}));
vi.mock("@ai-sdk/deepinfra", () => ({
  deepinfra: { chat: vi.fn(), embedding: vi.fn() },
}));
vi.mock("@ai-sdk/google-vertex", () => ({
  createVertex: vi.fn(() => ({ chat: vi.fn(), embedding: vi.fn() })),
}));
vi.mock("../config", () => ({
  config: {
    OLLAMA_BASE_URL: undefined,
    OPENAI_API_KEY: undefined,
    OPENAI_BASE_URL: undefined,
    OPENROUTER_API_KEY: undefined,
    ORCAROUTER_API_KEY: "sk-orca-test",
    MODEL_NAME: undefined,
    MODEL_EMBEDDING_NAME: undefined,
    VERTEX_CREDENTIALS: undefined,
  },
}));

import { getModel, getEmbeddingModel } from "./generic-ai";

describe("generic-ai orcarouter provider", () => {
  it("registers an orcarouter provider pointing at api.orcarouter.ai", () => {
    const callIndex = createOpenRouterMock.mock.calls.findIndex(
      ([opts]) =>
        (opts as { baseURL?: string }).baseURL ===
        "https://api.orcarouter.ai/v1",
    );
    expect(callIndex).toBeGreaterThan(-1);

    const opts = createOpenRouterMock.mock.calls[callIndex][0] as {
      apiKey?: string;
      baseURL?: string;
      compatibility?: string;
    };
    expect(opts).toMatchObject({
      apiKey: "sk-orca-test",
      baseURL: "https://api.orcarouter.ai/v1",
      compatibility: "compatible",
    });
  });

  it("routes getModel requests through the orcarouter provider", () => {
    const callIndex = createOpenRouterMock.mock.calls.findIndex(
      ([opts]) =>
        (opts as { baseURL?: string }).baseURL ===
        "https://api.orcarouter.ai/v1",
    );
    const orcaProvider = createOpenRouterMock.mock.results[callIndex]
      .value as any;

    const model = getModel("openai/gpt-5.5", "orcarouter");

    expect(orcaProvider.chat).toHaveBeenCalledWith("openai/gpt-5.5");
    expect(model).toEqual({ id: "openai/gpt-5.5" });
  });

  it("routes getEmbeddingModel requests through the orcarouter provider", () => {
    const callIndex = createOpenRouterMock.mock.calls.findIndex(
      ([opts]) =>
        (opts as { baseURL?: string }).baseURL ===
        "https://api.orcarouter.ai/v1",
    );
    const orcaProvider = createOpenRouterMock.mock.results[callIndex]
      .value as any;

    const embedding = getEmbeddingModel(
      "openai/text-embedding-3-small",
      "orcarouter",
    );

    expect(orcaProvider.embedding).toHaveBeenCalledWith(
      "openai/text-embedding-3-small",
    );
    expect(embedding).toEqual({ id: "openai/text-embedding-3-small" });
  });
});
