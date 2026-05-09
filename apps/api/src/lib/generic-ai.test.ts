describe("generic-ai", () => {
  const createOpenAISpy = jest.fn();
  const openaiDefaultModelSpy = jest.fn();
  const openaiChatModelSpy = jest.fn();
  const openaiEmbeddingSpy = jest.fn();
  const createOllamaSpy = jest.fn();
  const ollamaModelSpy = jest.fn();
  const ollamaEmbeddingSpy = jest.fn();

  beforeEach(() => {
    jest.resetModules();

    createOpenAISpy.mockReset();
    openaiDefaultModelSpy.mockReset();
    openaiChatModelSpy.mockReset();
    openaiEmbeddingSpy.mockReset();
    createOllamaSpy.mockReset();
    ollamaModelSpy.mockReset();
    ollamaEmbeddingSpy.mockReset();

    createOpenAISpy.mockReturnValue(
      Object.assign(openaiDefaultModelSpy, {
        chat: openaiChatModelSpy,
        embedding: openaiEmbeddingSpy,
      }),
    );

    createOllamaSpy.mockReturnValue(
      Object.assign(ollamaModelSpy, {
        embedding: ollamaEmbeddingSpy,
      }),
    );

    jest.doMock("@ai-sdk/openai", () => ({
      createOpenAI: createOpenAISpy,
    }));
    jest.doMock("ollama-ai-provider", () => ({
      createOllama: createOllamaSpy,
    }));
    jest.doMock("@ai-sdk/anthropic", () => ({
      anthropic: jest.fn(),
    }));
    jest.doMock("@ai-sdk/groq", () => ({
      groq: jest.fn(),
    }));
    jest.doMock("@ai-sdk/google", () => ({
      google: jest.fn(),
    }));
    jest.doMock("@openrouter/ai-sdk-provider", () => ({
      createOpenRouter: jest.fn(() => jest.fn()),
    }));
    jest.doMock("@ai-sdk/fireworks", () => ({
      fireworks: jest.fn(),
    }));
    jest.doMock("@ai-sdk/deepinfra", () => ({
      deepinfra: jest.fn(),
    }));
    jest.doMock("@ai-sdk/google-vertex", () => ({
      createVertex: jest.fn(() =>
        Object.assign(jest.fn(), {
          embedding: jest.fn(),
        }),
      ),
    }));
  });

  afterEach(() => {
    jest.dontMock("@ai-sdk/openai");
    jest.dontMock("ollama-ai-provider");
    jest.dontMock("@ai-sdk/anthropic");
    jest.dontMock("@ai-sdk/groq");
    jest.dontMock("@ai-sdk/google");
    jest.dontMock("@openrouter/ai-sdk-provider");
    jest.dontMock("@ai-sdk/fireworks");
    jest.dontMock("@ai-sdk/deepinfra");
    jest.dontMock("@ai-sdk/google-vertex");
    jest.dontMock("../config");
  });

  function mockConfig(overrides: Record<string, unknown> = {}) {
    jest.doMock("../config", () => ({
      config: {
        OPENAI_API_KEY: "test-openai-key",
        OPENAI_BASE_URL: "https://example-openai.test/v1",
        OPENROUTER_API_KEY: undefined,
        OLLAMA_BASE_URL: undefined,
        MODEL_NAME: undefined,
        MODEL_EMBEDDING_NAME: undefined,
        VERTEX_CREDENTIALS: undefined,
        ...overrides,
      },
    }));
  }

  it("uses the default OpenAI model path when USE_RESPONSES_ENDPOINT is unset", () => {
    mockConfig();

    const { getModel } = require("./generic-ai");
    getModel("gpt-4.1", "openai");

    expect(openaiDefaultModelSpy).toHaveBeenCalledWith("gpt-4.1");
    expect(openaiChatModelSpy).not.toHaveBeenCalled();
  });

  it("uses chat completions when USE_RESPONSES_ENDPOINT is false", () => {
    mockConfig({
      USE_RESPONSES_ENDPOINT: false,
    });

    const { getModel } = require("./generic-ai");
    getModel("gpt-4.1", "openai");

    expect(openaiChatModelSpy).toHaveBeenCalledWith("gpt-4.1");
    expect(openaiDefaultModelSpy).not.toHaveBeenCalled();
  });

  it("still forces chat completions for o3-mini when responses are enabled", () => {
    mockConfig({
      USE_RESPONSES_ENDPOINT: true,
    });

    const { getModel } = require("./generic-ai");
    getModel("o3-mini", "openai");

    expect(openaiChatModelSpy).toHaveBeenCalledWith("o3-mini");
    expect(openaiDefaultModelSpy).not.toHaveBeenCalled();
  });

  it("uses the configured MODEL_NAME when switching OpenAI-compatible endpoints", () => {
    mockConfig({
      MODEL_NAME: "qianfan-compatible-model",
      USE_RESPONSES_ENDPOINT: false,
    });

    const { getModel } = require("./generic-ai");
    getModel("ignored-model-name", "openai");

    expect(openaiChatModelSpy).toHaveBeenCalledWith("qianfan-compatible-model");
    expect(openaiDefaultModelSpy).not.toHaveBeenCalled();
  });
});
