const mockConfig = vi.hoisted(() => ({}) as Record<string, string | undefined>);

vi.mock("../config", () => ({ config: mockConfig }));

import { resolveProvider } from "./generic-ai";

describe("resolveProvider", () => {
  beforeEach(() => {
    for (const key of Object.keys(mockConfig)) delete mockConfig[key];
  });

  it("routes openai to ollama on an Ollama-only self-host", () => {
    mockConfig.OLLAMA_BASE_URL = "http://host.docker.internal:11434/api";
    expect(resolveProvider("openai")).toBe("ollama");
  });

  it("treats blank OpenAI env vars as unset", () => {
    mockConfig.OLLAMA_BASE_URL = "http://host.docker.internal:11434/api";
    mockConfig.OPENAI_API_KEY = "";
    mockConfig.OPENAI_BASE_URL = "";
    expect(resolveProvider("openai")).toBe("ollama");
  });

  it("treats whitespace-only OpenAI env vars as unset", () => {
    mockConfig.OLLAMA_BASE_URL = "http://host.docker.internal:11434/api";
    mockConfig.OPENAI_API_KEY = "   ";
    mockConfig.OPENAI_BASE_URL = " \t";
    expect(resolveProvider("openai")).toBe("ollama");
  });

  it("keeps openai when OLLAMA_BASE_URL is whitespace-only", () => {
    mockConfig.OLLAMA_BASE_URL = "   ";
    expect(resolveProvider("openai")).toBe("openai");
  });

  it("keeps openai when an OpenAI key is configured alongside Ollama", () => {
    mockConfig.OLLAMA_BASE_URL = "http://host.docker.internal:11434/api";
    mockConfig.OPENAI_API_KEY = "sk-test";
    expect(resolveProvider("openai")).toBe("openai");
  });

  it("keeps openai when an OpenAI-compatible base URL is configured", () => {
    mockConfig.OLLAMA_BASE_URL = "http://host.docker.internal:11434/api";
    mockConfig.OPENAI_BASE_URL = "http://localhost:8000/v1";
    expect(resolveProvider("openai")).toBe("openai");
  });

  it("keeps openai when Ollama is not configured", () => {
    expect(resolveProvider("openai")).toBe("openai");
  });

  it("never reroutes other providers", () => {
    mockConfig.OLLAMA_BASE_URL = "http://host.docker.internal:11434/api";
    expect(resolveProvider("anthropic")).toBe("anthropic");
    expect(resolveProvider("extraction")).toBe("extraction");
  });
});
