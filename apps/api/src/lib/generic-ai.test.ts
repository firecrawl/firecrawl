import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  coreLlmProviderNames,
  type LlmModel,
  type LlmProvider,
} from "../service/llm-providers";

const fakeModel = (modelId: string, provider = "custom"): LlmModel =>
  ({
    specificationVersion: "v4",
    provider,
    modelId,
    supportedUrls: {},
    doGenerate: vi.fn(),
    doStream: vi.fn(),
  }) as unknown as LlmModel;

beforeEach(() => {
  vi.stubEnv("OLLAMA_BASE_URL", "");
  vi.stubEnv("MODEL_NAME", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function loadFresh(
  providers?: readonly LlmProvider[],
  extensions: Array<{
    name: string;
    llmProviders?: readonly LlmProvider[];
  }> = [],
) {
  vi.resetModules();
  const { createService, replaceService } = await import(
    "../service/service.js"
  );
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
  it("defines every built-in LLM provider in coreLlmProviderNames order", async () => {
    const { coreLlmProviders, cleanup } = await loadFresh();
    try {
      expect(coreLlmProviders.map(p => p.name)).toEqual([
        ...coreLlmProviderNames,
      ]);
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
    const { getModel, cleanup } = await loadFresh([]);
    try {
      expect(() => getModel("gpt-4o-mini", "openai")).toThrow(
        'LLM provider "openai" is not registered',
      );
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

  it("enforces US-only routing rules for built-in providers", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("OPENAI_US_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic");
    vi.stubEnv("VERTEX_USE_ADC", "true");
    const { getModel, cleanup } = await loadFresh();

    try {
      // OpenAI without US key or service account is refused.
      expect(() =>
        getModel("gpt-4o-mini", "openai", {
          teamFlags: { usOnly: true },
          feature: "JSON extraction",
        }),
      ).toThrow(
        "JSON extraction is not available for teams restricted to US-only processing.",
      );

      // Anthropic wraps with US inferenceGeo middleware.
      const claude = getModel("claude-sonnet-4-5", "anthropic", {
        teamFlags: { usOnly: true },
      });
      expect(claude.modelId).toBe("claude-sonnet-4-5");

      // Vertex allows only US-endpoint models.
      const allowedVertex = getModel("gemini-3.5-flash-lite", "vertex", {
        teamFlags: { usOnly: true },
      });
      expect(allowedVertex.modelId).toBe("gemini-3.5-flash-lite");

      expect(() =>
        getModel("gemini-2.5-pro", "vertex", {
          teamFlags: { usOnly: true },
          feature: "Query",
        }),
      ).toThrow(
        "Query is not available for teams restricted to US-only processing.",
      );

      // Providers without a US endpoint throw UsOnlyUnavailableError.
      expect(() =>
        getModel("llama3", "groq", {
          teamFlags: { usOnly: true },
          feature: "Fast mode",
        }),
      ).toThrow(
        "Fast mode is not available for teams restricted to US-only processing.",
      );
    } finally {
      cleanup();
    }
  });

  it("reports vertex enabled() from VERTEX_CREDENTIALS and VERTEX_USE_ADC", async () => {
    vi.stubEnv("VERTEX_CREDENTIALS", "");
    vi.stubEnv("VERTEX_USE_ADC", "false");
    const off = await loadFresh();
    try {
      const vertex = off.coreLlmProviders.find(p => p.name === "vertex");
      expect(vertex?.enabled()).toBe(false);
    } finally {
      off.cleanup();
    }

    vi.stubEnv("VERTEX_USE_ADC", "true");
    const on = await loadFresh();
    try {
      const vertex = on.coreLlmProviders.find(p => p.name === "vertex");
      expect(vertex?.enabled()).toBe(true);
    } finally {
      on.cleanup();
    }
  });

  it("fails fast when VERTEX_CREDENTIALS is malformed", async () => {
    vi.stubEnv("VERTEX_CREDENTIALS", "not-valid-json");
    vi.resetModules();
    await expect(import("./generic-ai.js")).rejects.toThrow();
  });
});
