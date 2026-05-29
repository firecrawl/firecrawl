import { fetchWithAnthropicThinkingDisabled } from "./generic-ai";

describe("fetchWithAnthropicThinkingDisabled", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = jest.fn(async () => new Response("{}")) as any;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("adds thinking disabled to Anthropic JSON requests that omit thinking", async () => {
    await fetchWithAnthropicThinkingDisabled(
      "https://api.example.test/messages",
      {
        method: "POST",
        body: JSON.stringify({
          model: "deepseek-v4-pro",
          messages: [{ role: "user", content: "extract json" }],
          tool_choice: { type: "tool", name: "json" },
        }),
      },
    );

    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(JSON.parse(init.body)).toMatchObject({
      thinking: { type: "disabled" },
    });
  });

  it("does not overwrite explicit thinking configuration", async () => {
    await fetchWithAnthropicThinkingDisabled(
      "https://api.example.test/messages",
      {
        method: "POST",
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          thinking: { type: "enabled", budget_tokens: 1024 },
        }),
      },
    );

    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(JSON.parse(init.body).thinking).toEqual({
      type: "enabled",
      budget_tokens: 1024,
    });
  });

  it("passes non-JSON bodies through unchanged", async () => {
    await fetchWithAnthropicThinkingDisabled(
      "https://api.example.test/messages",
      {
        method: "POST",
        body: "not-json",
      },
    );

    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(init.body).toBe("not-json");
  });
});
