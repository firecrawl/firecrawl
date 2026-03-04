import { describe, test, expect } from "@jest/globals";

// We need to test the prepareAgentPayload function, but it's not exported.
// Since the function is internal, we'll test the behavior through type checking
// and verify the types are properly exported.

import type { AgentWebhookConfig, AgentWebhookEvent } from "../../../v2/types";
import { startAgent } from "../../../v2/methods/agent";

describe("v2 types: Agent webhook types", () => {
  test("AgentWebhookConfig accepts string webhook", () => {
    // Type check - this should compile without errors
    const webhook: string | AgentWebhookConfig = "https://example.com/webhook";
    expect(typeof webhook).toBe("string");
  });

  test("AgentWebhookConfig accepts config object", () => {
    const config: AgentWebhookConfig = {
      url: "https://example.com/webhook",
      headers: { Authorization: "Bearer token" },
      events: ["completed", "failed"],
    };
    expect(config.url).toBe("https://example.com/webhook");
    expect(config.headers).toEqual({ Authorization: "Bearer token" });
    expect(config.events).toEqual(["completed", "failed"]);
  });

  test("AgentWebhookConfig accepts minimal config", () => {
    const config: AgentWebhookConfig = {
      url: "https://example.com/webhook",
    };
    expect(config.url).toBe("https://example.com/webhook");
    expect(config.headers).toBeUndefined();
    expect(config.metadata).toBeUndefined();
    expect(config.events).toBeUndefined();
  });

  test("AgentWebhookEvent includes agent-specific events", () => {
    const events: AgentWebhookEvent[] = [
      "started",
      "action",
      "completed",
      "failed",
      "cancelled",
    ];
    expect(events).toContain("action");
    expect(events).toContain("cancelled");
    expect(events.length).toBe(5);
  });

  test("AgentWebhookConfig accepts all fields", () => {
    const config: AgentWebhookConfig = {
      url: "https://example.com/webhook",
      headers: {
        Authorization: "Bearer token",
        "X-Custom-Header": "value",
      },
      metadata: {
        project: "test",
        environment: "staging",
      },
      events: ["started", "action", "completed", "failed", "cancelled"],
    };
    expect(config.url).toBe("https://example.com/webhook");
    expect(Object.keys(config.headers!).length).toBe(2);
    expect(config.metadata!.project).toBe("test");
    expect(config.events!.length).toBe(5);
  });

  test("AgentWebhookConfig events are agent-specific (not crawl)", () => {
    // Agent has 'action' and 'cancelled', but not 'page'
    const config: AgentWebhookConfig = {
      url: "https://example.com/webhook",
      events: ["action", "cancelled"],
    };
    expect(config.events).toContain("action");
    expect(config.events).toContain("cancelled");
    // 'page' is a crawl-specific event, not valid for agent
    // This is enforced at the type level
  });

  test("startAgent passes zeroDataRetention", async () => {
    const post = jest.fn().mockResolvedValue({
      status: 200,
      data: { success: true, id: "agent-123" },
    });
    const http = { post } as any;
    await startAgent(http, {
      prompt: "Test ZDR",
      zeroDataRetention: true,
    });
    expect(post).toHaveBeenCalledWith(
      "/v2/agent",
      expect.objectContaining({ zeroDataRetention: true }),
    );
  });
});
