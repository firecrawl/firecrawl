import { describe, expect, it, vi } from "vitest";
import {
  buildLlmProviderRegistry,
  coreLlmProviderNames,
} from "./llm-providers";
import type { LlmModel, LlmProvider } from "./llm-providers";

type V4Model = Extract<LlmModel, { specificationVersion: "v4" }>;

const fakeModel = (id: string): LlmModel => ({
  specificationVersion: "v4",
  provider: "test",
  modelId: id,
  supportedUrls: {},
  doGenerate: vi.fn<V4Model["doGenerate"]>(),
  doStream: vi.fn<V4Model["doStream"]>(),
});

const makeProvider = (
  name: string,
  overrides: {
    enabled?: () => boolean;
    model?: LlmProvider["model"];
  } = {},
): LlmProvider => ({
  // @ts-expect-error: test provider names exercise open declaration-merged LlmProviderName
  name,
  enabled: () => true,
  model: vi.fn((id: string) => fakeModel(id)),
  ...overrides,
});

describe("buildLlmProviderRegistry", () => {
  it("preserves registration order and evaluates enabled() at call time", () => {
    let secondEnabled = false;
    const first = makeProvider("openai", { enabled: () => true });
    const second = makeProvider("vertex", { enabled: () => secondEnabled });
    const third = makeProvider("anthropic", { enabled: () => true });

    const { registry, describedLlmProviders } = buildLlmProviderRegistry([
      { owner: "core", llmProviders: [first, second] },
      { owner: "extra", llmProviders: [third] },
    ]);

    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.all())).toBe(true);
    expect(registry.all().map(p => p.name)).toEqual([
      "openai",
      "vertex",
      "anthropic",
    ]);
    expect(registry.enabled().map(p => p.name)).toEqual([
      "openai",
      "anthropic",
    ]);

    secondEnabled = true;
    expect(registry.enabled().map(p => p.name)).toEqual([
      "openai",
      "vertex",
      "anthropic",
    ]);
    expect(describedLlmProviders).toEqual({
      anthropic: "extra",
      openai: "core",
      vertex: "core",
    });
  });

  it("replaces an earlier provider of the same name in place and updates its owner", () => {
    const coreOpenAIModel = vi.fn((id: string) => fakeModel(`core:${id}`));
    const coreAnthropicModel = vi.fn((id: string) =>
      fakeModel(`anthropic:${id}`),
    );
    const overrideOpenAIModel = vi.fn((id: string) =>
      fakeModel(`override:${id}`),
    );
    const coreOpenAI = makeProvider("openai", { model: coreOpenAIModel });
    const coreAnthropic = makeProvider("anthropic", {
      model: coreAnthropicModel,
    });
    const overrideOpenAI = makeProvider("openai", {
      model: overrideOpenAIModel,
    });

    const { registry, describedLlmProviders } = buildLlmProviderRegistry([
      { owner: "core", llmProviders: [coreOpenAI, coreAnthropic] },
      { owner: "custom", llmProviders: [overrideOpenAI] },
    ]);

    expect(registry.all().map(p => p.name)).toEqual(["openai", "anthropic"]);
    expect(registry.get("openai")?.model("gpt-4o-mini").modelId).toBe(
      "override:gpt-4o-mini",
    );
    expect(overrideOpenAIModel).toHaveBeenCalledTimes(1);
    expect(coreOpenAIModel).not.toHaveBeenCalled();
    expect(registry.get("anthropic")?.model("claude").modelId).toBe(
      "anthropic:claude",
    );
    expect(coreAnthropicModel).toHaveBeenCalledTimes(1);
    expect(describedLlmProviders).toEqual({
      anthropic: "core",
      openai: "custom",
    });
  });

  it("returns disabled providers from get() and undefined for unregistered names", () => {
    const disabled = makeProvider("vertex", { enabled: () => false });
    const { registry } = buildLlmProviderRegistry([
      { owner: "core", llmProviders: [disabled] },
    ]);

    expect(registry.get("vertex")?.name).toBe("vertex");
    expect(registry.get("vertex")?.enabled()).toBe(false);
    expect(registry.get("not-registered")).toBeUndefined();
    expect(registry.get("toString")).toBeUndefined();
    expect(registry.get("constructor")).toBeUndefined();
  });

  it("snapshots providers so later mutation does not alter the registry", () => {
    const originalModel = vi.fn((id: string) => fakeModel(`orig:${id}`));
    const replacementModel = vi.fn((id: string) => fakeModel(`other:${id}`));
    const provider = {
      name: "openai" as const,
      enabled: () => true,
      model: originalModel,
    };
    const list: Array<LlmProvider> = [provider];

    const { registry } = buildLlmProviderRegistry([
      { owner: "core", llmProviders: list },
    ]);

    list.push(makeProvider("anthropic"));
    // @ts-expect-error: mutating provider name after registration to verify snapshotting
    provider.name = "mutated";
    provider.model = replacementModel;

    expect(registry.all().map(p => p.name)).toEqual(["openai"]);
    expect(Object.isFrozen(registry.get("openai"))).toBe(true);
    expect(registry.get("openai")?.model("gpt-4o-mini").modelId).toBe(
      "orig:gpt-4o-mini",
    );
    expect(originalModel).toHaveBeenCalledTimes(1);
    expect(replacementModel).not.toHaveBeenCalled();
  });

  it("preserves method this-binding for class-based providers", () => {
    class StatefulProvider implements LlmProvider {
      readonly name = "openai" as const;
      private active = true;
      private prefix = "stateful:";

      enabled() {
        return this.active;
      }

      model(id: string) {
        return fakeModel(`${this.prefix}${id}`);
      }
    }

    const { registry } = buildLlmProviderRegistry([
      { owner: "custom", llmProviders: [new StatefulProvider()] },
    ]);

    const registered = registry.get("openai");
    expect(registered?.enabled()).toBe(true);
    expect(registered?.model("gpt-4o-mini").modelId).toBe(
      "stateful:gpt-4o-mini",
    );
  });

  it("handles prototype property names safely", () => {
    const protoProvider = makeProvider("__proto__");
    const ctorProvider = makeProvider("constructor");

    const { registry, describedLlmProviders } = buildLlmProviderRegistry([
      { owner: "core", llmProviders: [protoProvider, ctorProvider] },
    ]);

    expect(registry.get("__proto__")?.name).toBe("__proto__");
    expect(registry.get("constructor")?.name).toBe("constructor");
    expect(Object.entries(describedLlmProviders)).toEqual([
      ["__proto__", "core"],
      ["constructor", "core"],
    ]);
  });

  it("validates provider fields at registration time", () => {
    expect(() =>
      buildLlmProviderRegistry([
        { owner: "core", llmProviders: [makeProvider("")] },
      ]),
    ).toThrow("LLM provider name must be a non-empty string");

    expect(() =>
      buildLlmProviderRegistry([
        {
          owner: "core",
          llmProviders: [
            makeProvider("openai", {
              // @ts-expect-error: verifying runtime rejection of non-function enabled
              enabled: "yes",
            }),
          ],
        },
      ]),
    ).toThrow('LLM provider "openai" enabled must be a function');

    expect(() =>
      buildLlmProviderRegistry([
        {
          owner: "core",
          llmProviders: [
            makeProvider("openai", {
              // @ts-expect-error: verifying runtime rejection of null model
              model: null,
            }),
          ],
        },
      ]),
    ).toThrow('LLM provider "openai" model must be a function');
  });

  it("lists the built-in LLM provider names in order", () => {
    expect(coreLlmProviderNames).toEqual(["openai", "ollama"]);
    expect(Object.isFrozen(coreLlmProviderNames)).toBe(true);
  });
});
