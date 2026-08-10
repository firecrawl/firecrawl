vi.mock("../../config", () => ({
  config: {
    OPENAI_API_KEY: "openai-key",
    NOVITA_API_KEY: "novita-key",
  },
}));

import { getModel } from "../generic-ai";

describe("getModel novita provider", () => {
  it("uses the Chat Completions path, not the Responses API", () => {
    // Novita's OpenAI-compatible endpoint only implements
    // /v1/chat/completions; the AI SDK's bare createOpenAI() call defaults
    // to the Responses API, which 404s against Novita.
    const model = getModel("deepseek/deepseek-v4-pro", "novita");
    expect(model.provider).toBe("openai.chat");
    expect(model.modelId).toBe("deepseek/deepseek-v4-pro");
  });
});
