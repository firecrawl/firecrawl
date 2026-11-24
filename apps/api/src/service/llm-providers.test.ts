import { describe, expect, it, vi } from "vitest";
import {
  buildLlmProviderRegistry,
  coreLlmProviderNames,
  type LlmModel,
  type LlmProvider,
} from "./llm-providers";

const fakeModel = (id: string): LlmModel =>
  ({
    specificationVersion: "v4",
    provider: "test",
    modelId: id,
    supportedUrls: {},
    doGenerate: vi.fn(),
    doStream: vi.fn(),
  }) as unknown as LlmModel;

const makeProvider = (
  name: string,
  overrides: {
    enabled?: () => boolean;
    model?: LlmProvider["model"];
  } = {},
): LlmProvider =>
  ({
    name,
    enabled: () => true,
    model: vi.fn((id: string) => fakeModel(id)),
    ...overrides,
  }) as unknown as LlmProvider;

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
    const coreOpenAI = makeProvider("openai");
    const coreAnthropic = makeProvider("anthropic");
    const overrideOpenAI = makeProvider("openai");

    const { registry, describedLlmProviders } = buildLlmProviderRegistry([
      { owner: "core", llmProviders: [coreOpenAI, coreAnthropic] },
      { owner: "custom", llmProviders: [overrideOpenAI] },
    ]);

    expect(registry.all().map(p => p.name)).toEqual(["openai", "anthropic"]);
    expect(registry.get("openai")?.model).toBe(overrideOpenAI.model);
    expect(registry.get("anthropic")?.model).toBe(coreAnthropic.model);
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
    const originalModel = vi.fn((id: string) => fakeModel(id));
    const provider = makeProvider("openai", { model: originalModel }) as {
      name: string;
      enabled: () => boolean;
      model: LlmProvider["model"];
    };
    const list = [provider as unknown as LlmProvider];

    const { registry } = buildLlmProviderRegistry([
      { owner: "core", llmProviders: list },
    ]);

    list.push(makeProvider("anthropic"));
    provider.name = "mutated";
    provider.model = vi.fn((id: string) => fakeModel(`other:${id}`));

    expect(registry.all().map(p => p.name)).toEqual(["openai"]);
    expect(Object.isFrozen(registry.get("openai"))).toBe(true);
    expect(registry.get("openai")?.model).toBe(originalModel);
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
              enabled: "yes" as unknown as () => boolean,
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
              model: null as unknown as LlmProvider["model"],
            }),
          ],
        },
      ]),
    ).toThrow('LLM provider "openai" model must be a function');
  });

  it("lists all nine built-in LLM provider names in order", () => {
    expect(coreLlmProviderNames).toEqual([
      "openai",
      "ollama",
      "anthropic",
      "groq",
      "google",
      "openrouter",
      "fireworks",
      "deepinfra",
      "vertex",
    ]);
    expect(Object.isFrozen(coreLlmProviderNames)).toBe(true);
  });
});
