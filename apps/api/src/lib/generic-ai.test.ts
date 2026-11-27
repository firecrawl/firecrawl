import { MockLanguageModelV3 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coreLlmProviderNames } from "../service/llm-providers";
import type {
  LlmModel,
  LlmProvider,
  LlmProviderName,
} from "../service/llm-providers";

const fakeModel = (modelId: string, provider = "custom"): LlmModel =>
  new MockLanguageModelV3({
    provider,
    modelId,
  });

function isExtensionProviderName(name: string): name is LlmProviderName {
  return name.length > 0;
}

beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("OPENAI_BASE_URL", "");
  vi.stubEnv("OLLAMA_BASE_URL", "");
  vi.stubEnv("MODEL_NAME", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function loadFresh(
  providers?: ReadonlyArray<LlmProvider>,
  extensions: Array<{
    name: string;
    llmProviders?: ReadonlyArray<LlmProvider>;
  }> = [],
) {
  vi.resetModules();
  const { createService, replaceService } =
    await import("../service/service.js");
  const genericAi = await import("./generic-ai.js");
  replaceService(
    createService(
      { modules: {}, extensions },
      {
        core: {
          name: "core",
          llmProviders: providers ?? genericAi.coreLlmProviders,
        },
        logger: { error: vi.fn() },
      },
    ),
  );
  return {
    ...genericAi,
    cleanup: () => replaceService(undefined),
  };
}

describe("coreLlmProviders and getModel", () => {
  it("defines only openai and ollama in coreLlmProviderNames order", async () => {
    const { coreLlmProviders, cleanup } = await loadFresh();
    try {
      expect(coreLlmProviders.map(p => p.name)).toEqual(["openai", "ollama"]);
      expect(coreLlmProviders.map(p => p.name)).toEqual([
        ...coreLlmProviderNames,
      ]);
    } finally {
      cleanup();
    }
  });

  it("reports openai and ollama enabled() from OPENAI_API_KEY, OPENAI_BASE_URL, and OLLAMA_BASE_URL", async () => {
    const disabled = await loadFresh();
    try {
      expect(
        disabled.coreLlmProviders.find(p => p.name === "openai")?.enabled(),
      ).toBe(false);
      expect(
        disabled.coreLlmProviders.find(p => p.name === "ollama")?.enabled(),
      ).toBe(false);
    } finally {
      disabled.cleanup();
    }

    vi.stubEnv("OPENAI_API_KEY", "   ");
    vi.stubEnv("OLLAMA_BASE_URL", "   ");
    const whitespaceKey = await loadFresh();
    try {
      expect(
        whitespaceKey.coreLlmProviders
          .find(p => p.name === "openai")
          ?.enabled(),
      ).toBe(false);
      expect(
        whitespaceKey.coreLlmProviders
          .find(p => p.name === "ollama")
          ?.enabled(),
      ).toBe(false);
      expect(whitespaceKey.getModel("gpt-4o-mini").provider).toBe(
        "openai.responses",
      );
    } finally {
      whitespaceKey.cleanup();
    }

    vi.stubEnv("OLLAMA_BASE_URL", "");
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    const apiKeyOnly = await loadFresh();
    try {
      expect(
        apiKeyOnly.coreLlmProviders.find(p => p.name === "openai")?.enabled(),
      ).toBe(true);
      expect(
        apiKeyOnly.coreLlmProviders.find(p => p.name === "ollama")?.enabled(),
      ).toBe(false);
    } finally {
      apiKeyOnly.cleanup();
    }

    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("OPENAI_BASE_URL", "http://localhost:8080/v1");
    vi.stubEnv("OLLAMA_BASE_URL", "http://localhost:11434/api");
    const enabled = await loadFresh();
    try {
      expect(
        enabled.coreLlmProviders.find(p => p.name === "openai")?.enabled(),
      ).toBe(true);
      expect(
        enabled.coreLlmProviders.find(p => p.name === "ollama")?.enabled(),
      ).toBe(true);
    } finally {
      enabled.cleanup();
    }
  });

  it("refuses core openai and ollama models for US-only teams", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    vi.stubEnv("OLLAMA_BASE_URL", "http://localhost:11434/api");
    const { getModel, cleanup } = await loadFresh();
    const { UsOnlyUnavailableError } =
      await import("../scraper/scrapeURL/error.js");
    try {
      expect(() =>
        getModel("gpt-4o-mini", "openai", {
          teamFlags: { usOnly: true },
          feature: "Extract",
        }),
      ).toThrow(UsOnlyUnavailableError);
      expect(() =>
        getModel("llama3", "ollama", {
          teamFlags: { usOnly: true },
          feature: "Extract",
        }),
      ).toThrow(UsOnlyUnavailableError);
    } finally {
      cleanup();
    }
  });

  it("routes getModel through service.llmProviders and applies extension replacements", async () => {
    const modelFn = vi.fn((id: string) => fakeModel(id, "custom-openai"));
    const { getModel, cleanup } = await loadFresh(undefined, [
      {
        name: "custom",
        llmProviders: [
          {
            name: "openai",
            enabled: () => true,
            model: modelFn,
          },
        ],
      },
    ]);

    try {
      const ctx = { teamId: "team-1", zeroDataRetention: false };
      const teamFlags = { usOnly: false };
      const result = getModel("gpt-4o-mini", "openai", {
        ctx,
        teamFlags,
        feature: "Extract",
      });

      expect(modelFn).toHaveBeenCalledWith("gpt-4o-mini", {
        ctx,
        teamFlags,
        feature: "Extract",
      });
      expect(result.modelId).toBe("gpt-4o-mini");
      expect(result.provider).toBe("custom-openai");
    } finally {
      cleanup();
    }
  });

  it("resolves extension-contributed non-core LLM providers via getModel", async () => {
    const customModelFn = vi.fn((id: string) => fakeModel(id, "custom-ext"));
    const customName = "custom-ext";
    if (!isExtensionProviderName(customName)) {
      throw new Error("Expected non-empty provider name");
    }
    const customProvider: LlmProvider = {
      name: customName,
      enabled: () => true,
      model: customModelFn,
    };

    const { getModel, cleanup } = await loadFresh(undefined, [
      {
        name: "extra",
        llmProviders: [customProvider],
      },
    ]);

    try {
      const ctx = { teamId: "team-2", zeroDataRetention: true };
      const result = getModel("custom-model-1", "custom-ext", {
        ctx,
        feature: "Query",
      });

      expect(customModelFn).toHaveBeenCalledWith("custom-model-1", {
        ctx,
        teamFlags: undefined,
        feature: "Query",
      });
      expect(result.modelId).toBe("custom-model-1");
      expect(result.provider).toBe("custom-ext");
    } finally {
      cleanup();
    }
  });

  it("applies MODEL_NAME unless ignoreModelOverride is set", async () => {
    vi.stubEnv("MODEL_NAME", "override-model");
    const modelFn = vi.fn((id: string) => fakeModel(id));
    const { getModel, cleanup } = await loadFresh([
      { name: "openai", enabled: () => true, model: modelFn },
    ]);

    try {
      expect(getModel("gpt-4o-mini", "openai").modelId).toBe("override-model");
      expect(
        getModel("gpt-4o-mini", "openai", { ignoreModelOverride: true })
          .modelId,
      ).toBe("gpt-4o-mini");
    } finally {
      cleanup();
    }
  });

  it("defaults to ollama when OLLAMA_BASE_URL is set, otherwise openai", async () => {
    vi.stubEnv("OLLAMA_BASE_URL", "http://localhost:11434/api");
    const ollamaModel = vi.fn((id: string) => fakeModel(id, "ollama"));
    const openaiModel = vi.fn((id: string) => fakeModel(id, "openai"));
    const withOllama = await loadFresh([
      { name: "openai", enabled: () => true, model: openaiModel },
      { name: "ollama", enabled: () => true, model: ollamaModel },
    ]);

    try {
      expect(withOllama.getModel("llama3").provider).toBe("ollama");
      expect(ollamaModel).toHaveBeenCalledTimes(1);
      expect(openaiModel).not.toHaveBeenCalled();
    } finally {
      withOllama.cleanup();
    }

    vi.stubEnv("OLLAMA_BASE_URL", "");
    vi.stubEnv("MODEL_NAME", "");
    const withoutOllama = await loadFresh([
      { name: "openai", enabled: () => true, model: openaiModel },
      { name: "ollama", enabled: () => false, model: ollamaModel },
    ]);

    try {
      expect(withoutOllama.getModel("gpt-4o-mini").provider).toBe("openai");
      expect(openaiModel).toHaveBeenCalledTimes(1);
    } finally {
      withoutOllama.cleanup();
    }
  });

  it("throws when the requested provider is not registered", async () => {
    const { getModel, cleanup } = await loadFresh();
    try {
      for (const name of [
        "anthropic",
        "groq",
        "google",
        "openrouter",
        "fireworks",
        "deepinfra",
        "vertex",
      ]) {
        expect(() => getModel("some-model", name)).toThrow(
          `LLM provider "${name}" is not registered`,
        );
      }
    } finally {
      cleanup();
    }
  });

  it("uses chat completions for o3-mini on openai", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const { getModel, cleanup } = await loadFresh();
    try {
      const o3 = getModel("o3-mini", "openai");
      const gpt = getModel("gpt-4o-mini", "openai");
      expect(o3.provider).toBe("openai.chat");
      expect(gpt.provider).toBe("openai.responses");
    } finally {
      cleanup();
    }
  });
});
