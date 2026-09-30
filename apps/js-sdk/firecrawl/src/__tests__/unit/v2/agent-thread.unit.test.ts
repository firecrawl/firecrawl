import { describe, expect, jest, test } from "@jest/globals";
import {
  getAgentStatus,
  getAgentThread,
  startAgent,
} from "../../../v2/methods/agent";

const okPost = () =>
  jest.fn().mockResolvedValue({
    status: 200,
    data: { success: true, id: "agent-job", threadId: "thread-1", threadTurn: 2 },
  });

describe("v2.agent threads unit", () => {
  test("startAgent forwards the thread fields when set", async () => {
    const post = okPost();

    await startAgent({ post } as any, {
      prompt: "Which tier has SSO?",
      threadId: "thread-1",
      mode: "chat",
      exchange: { enabled: true, toolkits: ["a", "b"] },
    });

    expect(post).toHaveBeenCalledWith("/v2/agent", {
      prompt: "Which tier has SSO?",
      threadId: "thread-1",
      mode: "chat",
      exchange: { enabled: true, toolkits: ["a", "b"] },
    });
  });

  test("startAgent omits the thread fields when unset", async () => {
    const post = okPost();

    await startAgent({ post } as any, { prompt: "List the pricing tiers" });

    expect(post).toHaveBeenCalledWith("/v2/agent", {
      prompt: "List the pricing tiers",
    });
  });

  test("startAgent returns the thread the run belongs to", async () => {
    const started = await startAgent({ post: okPost() } as any, {
      prompt: "Which tier has SSO?",
      threadId: "thread-1",
    });

    expect(started.threadId).toBe("thread-1");
    expect(started.threadTurn).toBe(2);
  });

  test("getAgentStatus parses a chat-mode status payload", async () => {
    const get = jest.fn().mockResolvedValue({
      status: 200,
      data: {
        success: true,
        status: "completed",
        data: null,
        model: "spark-2",
        expiresAt: "2026-09-02T00:00:00.000Z",
        threadId: "thread-1",
        threadTurn: 2,
        mode: "chat",
        message: "Only the Enterprise tier lists SSO.",
        suggestions: [{ label: "Seat caps?", prompt: "Does Team cap seats?" }],
        pendingApproval: {
          id: "approval-1",
          reason: "One paid call answers this.",
          calls: [
            {
              id: "call-1",
              provider: "provider-1",
              capability: "capability-1",
              input: { query: "sso" },
              creditsEstimate: 5,
            },
          ],
          resolution: null,
        },
        exchange: { enabled: true, paidCalls: 0, creditsUsed: null },
      },
    });

    const status = await getAgentStatus({ get } as any, "agent-job");

    expect(get).toHaveBeenCalledWith("/v2/agent/agent-job");
    expect(status.data).toBeNull();
    expect(status.message).toBe("Only the Enterprise tier lists SSO.");
    expect(status.mode).toBe("chat");
    expect(status.threadTurn).toBe(2);
    expect(status.suggestions).toHaveLength(1);
    expect(status.pendingApproval!.calls[0].creditsEstimate).toBe(5);
    expect(status.exchange!.paidCalls).toBe(0);
  });

  test("getAgentStatus parses a status payload without the thread fields", async () => {
    const get = jest.fn().mockResolvedValue({
      status: 200,
      data: {
        success: true,
        status: "completed",
        data: { price: 42 },
        model: "spark-2",
        expiresAt: "2026-09-02T00:00:00.000Z",
        creditsUsed: 12,
      },
    });

    const status = await getAgentStatus({ get } as any, "agent-job");

    expect(status.data).toEqual({ price: 42 });
    expect(status.threadId).toBeUndefined();
    expect(status.message).toBeUndefined();
    expect(status.pendingApproval).toBeUndefined();
  });

  test("getAgentThread hits the thread endpoint", async () => {
    const get = jest.fn().mockResolvedValue({
      status: 200,
      data: {
        success: true,
        thread: {
          id: "thread-1",
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:01:00.000Z",
          status: "idle",
          runs: [
            {
              id: "agent-job",
              turn: 1,
              mode: "chat",
              prompt: "List the pricing tiers",
              status: "succeeded",
              createdAt: "2026-09-01T00:00:00.000Z",
              finishedAt: "2026-09-01T00:00:30.000Z",
              creditsUsed: 212,
              message: null,
            },
          ],
        },
      },
    });

    const thread = await getAgentThread({ get } as any, "thread-1");

    expect(get).toHaveBeenCalledWith("/v2/agent/threads/thread-1");
    expect(thread.thread!.runs).toHaveLength(1);
    expect(thread.thread!.runs[0].turn).toBe(1);
  });

  test("getAgentThread appends includeData when requested", async () => {
    const get = jest.fn().mockResolvedValue({
      status: 200,
      data: { success: true, thread: { id: "thread-1", runs: [] } },
    });

    await getAgentThread({ get } as any, "thread-1", { includeData: true });

    expect(get).toHaveBeenCalledWith(
      "/v2/agent/threads/thread-1?includeData=true",
    );
  });
  test("startAgent forwards exchange.onTermsRequired and a terms approve", async () => {
    const post = okPost();
    const exchange = {
      onTermsRequired: "ask" as const,
      approve: { approvalId: "0199aaaa-0000-7000-8000-000000000000" },
    };

    await startAgent({ post } as any, {
      prompt: "Continue",
      threadId: "thread-1",
      exchange,
    });

    expect(post).toHaveBeenCalledWith("/v2/agent", {
      prompt: "Continue",
      threadId: "thread-1",
      exchange,
    });
  });

  test("startAgent forwards exchange.onTermsRequired skip", async () => {
    const post = okPost();

    await startAgent({ post } as any, {
      prompt: "Find the key business contact at exa.ai",
      exchange: { onTermsRequired: "skip" },
    });

    expect(post).toHaveBeenCalledWith("/v2/agent", {
      prompt: "Find the key business contact at exa.ai",
      exchange: { onTermsRequired: "skip" },
    });
  });

  test("getAgentStatus parses skippedProviders, requiresAction and a terms approval", async () => {
    const approvalId = "0199aaaa-0000-7000-8000-000000000000";
    const get = jest.fn().mockResolvedValue({
      status: 200,
      data: {
        success: true,
        status: "completed",
        data: null,
        model: "spark-2",
        expiresAt: "2026-09-02T00:00:00.000Z",
        exchange: {
          enabled: true,
          onTermsRequired: "ask",
          paidCalls: 0,
          creditsUsed: null,
          skippedProviders: [
            {
              provider: "apollo",
              name: "Apollo",
              capability: "people/search",
              adds: "verified work emails",
              reason: "terms_required",
              version: "F-1.0.0",
              termsUrl: "https://www.firecrawl.dev/app/alexandria/apollo",
            },
          ],
          requiresAction: {
            type: "accept_terms",
            approvalId,
            providers: [
              {
                provider: "apollo",
                name: "Apollo",
                version: "F-1.0.0",
                digest: null,
                url: "https://www.firecrawl.dev/app/alexandria/apollo",
                show: {
                  provider: "firecrawl",
                  capability: "terms/show",
                  options: { provider: "apollo" },
                },
                accept: {
                  provider: "firecrawl",
                  capability: "terms/accept",
                  options: {
                    provider: "apollo",
                    version: "F-1.0.0",
                    digest: null,
                    confirmed: true,
                  },
                },
              },
            ],
          },
        },
        pendingApproval: {
          id: approvalId,
          kind: "terms",
          reason: "Apollo could add verified work emails.",
          calls: [],
          terms: [
            {
              provider: "apollo",
              name: "Apollo",
              version: "F-1.0.0",
              digest: null,
              url: "https://www.firecrawl.dev/app/alexandria/apollo",
            },
          ],
          resolution: null,
        },
      },
    });

    const status = await getAgentStatus({ get } as any, "agent-job");

    expect(status.exchange!.onTermsRequired).toBe("ask");
    expect(status.exchange!.skippedProviders![0].reason).toBe("terms_required");
    const action = status.exchange!.requiresAction!;
    expect(action.approvalId).toBe(approvalId);
    expect(action.providers[0].accept.capability).toBe("terms/accept");
    expect(action.providers[0].accept.options.digest).toBeNull();
    const pending = status.pendingApproval!;
    expect(pending.kind).toBe("terms");
    if (pending.kind !== "terms") throw new Error("expected a terms approval");
    expect(pending.calls).toEqual([]);
    expect(pending.terms[0].provider).toBe("apollo");
  });
});
