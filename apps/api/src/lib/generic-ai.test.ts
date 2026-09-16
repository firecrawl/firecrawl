import { describe, expect, it } from "vitest";
import { getModel, selectDefaultProvider } from "./generic-ai";

describe("Atlas Cloud provider", () => {
  it("selects Atlas Cloud when no local Ollama endpoint is configured", () => {
    expect(selectDefaultProvider(undefined, "atlas-key")).toBe("atlascloud");
    expect(selectDefaultProvider("http://localhost:11434", "atlas-key")).toBe(
      "ollama",
    );
  });

  it("uses the Atlas Cloud default nested model ID", () => {
    const model = getModel("ignored", "atlascloud");

    expect(model.provider).toBe("openai.chat");
    expect(model.modelId).toBe("deepseek-ai/deepseek-v4-pro");
  });
});
