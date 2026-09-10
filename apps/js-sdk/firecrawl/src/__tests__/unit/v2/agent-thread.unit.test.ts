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
});
