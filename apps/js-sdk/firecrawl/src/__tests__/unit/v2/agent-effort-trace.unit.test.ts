import { describe, expect, jest, test } from "@jest/globals";
import {
  startAgent,
  getAgentTrace,
  getAgentSnapshot,
} from "../../../v2/methods/agent";
import type { AgentTraceEvent } from "../../../v2/types";

describe("v2.agent unit", () => {
  test("startAgent forwards effort in request payload", async () => {
    const post = jest.fn().mockResolvedValue({
      status: 200,
      data: { success: true, id: "agent-job" },
    });

    await startAgent({ post } as any, {
      prompt: "Find the pricing",
      effort: "high",
    });

    expect(post).toHaveBeenCalledWith("/v2/agent", {
      prompt: "Find the pricing",
      effort: "high",
    });
  });

  test("startAgent omits effort when unset", async () => {
    const post = jest.fn().mockResolvedValue({
      status: 200,
      data: { success: true, id: "agent-job" },
    });

    await startAgent({ post } as any, { prompt: "Find the pricing" });

    expect(post).toHaveBeenCalledWith("/v2/agent", {
      prompt: "Find the pricing",
    });
  });

  test("getAgentTrace hits the trace endpoint and returns typed events", async () => {
    const runStarted: AgentTraceEvent = {
      schemaVersion: 1,
      eventId: "018f3c5e-0000-7000-8000-000000000000",
      runId: "018f3c5e-0000-7000-8000-000000000001",
      occurredAt: "2026-08-26T12:00:00+00:00",
      producerSequence: 1,
      agent: {
        id: "018f3c5e-0000-7000-8000-000000000002",
        role: "orchestrator",
        name: "main",
      },
      type: "run.started",
    };
    const artifactUpdated: AgentTraceEvent = {
      schemaVersion: 1,
      eventId: "018f3c5e-0000-7000-8000-000000000010",
      runId: "018f3c5e-0000-7000-8000-000000000001",
      occurredAt: "2026-08-26T12:00:01+00:00",
      producerSequence: 2,
      agent: {
        id: "018f3c5e-0000-7000-8000-000000000002",
        role: "orchestrator",
        name: "main",
      },
      type: "artifact.updated",
      artifact: {
        kind: "json",
        artifactId: "result",
        snapshotId: "018f3c5e-0000-7000-8000-000000000003",
        change: "partial",
      },
    };
    const get = jest.fn().mockResolvedValue({
      status: 200,
      data: {
        success: true,
        id: "agent-job",
        events: [runStarted, artifactUpdated],
        creditsUsed: 5,
      },
    });

    const trace = await getAgentTrace({ get } as any, "agent-job");

    expect(get).toHaveBeenCalledWith("/v2/agent/agent-job/trace");
    expect(trace.events).toHaveLength(2);
    expect(trace.events![0].type).toBe("run.started");
    expect(trace.events![1].type).toBe("artifact.updated");
    if (trace.events![1].type === "artifact.updated") {
      expect(trace.events![1].artifact.snapshotId).toBe(
        "018f3c5e-0000-7000-8000-000000000003",
      );
    }
    expect(trace.creditsUsed).toBe(5);
  });

  test("getAgentTrace appends liveView query param when requested", async () => {
    const get = jest.fn().mockResolvedValue({
      status: 200,
      data: {
        success: true,
        id: "agent-job",
        events: [],
        creditsUsed: 0,
        activeBrowserSessions: [
          {
            id: "sess-1",
            liveViewUrl: "https://browser.example.com/sess-1",
            viewport: { width: 1280, height: 720 },
          },
        ],
      },
    });

    const trace = await getAgentTrace({ get } as any, "agent-job", {
      liveView: true,
    });

    expect(get).toHaveBeenCalledWith("/v2/agent/agent-job/trace?liveView=true");
    expect(trace.activeBrowserSessions).toHaveLength(1);
    expect(trace.activeBrowserSessions![0].viewport.width).toBe(1280);
  });

  test("getAgentSnapshot hits the snapshot endpoint", async () => {
    const get = jest.fn().mockResolvedValue({
      status: 200,
      data: {
        success: true,
        id: "agent-job",
        snapshotId: "snap-1",
        snapshot: '{"price": 42}',
      },
    });

    const snapshot = await getAgentSnapshot({ get } as any, "agent-job", "snap-1");

    expect(get).toHaveBeenCalledWith("/v2/agent/agent-job/snapshots/snap-1");
    expect(snapshot.snapshot).toBe('{"price": 42}');
  });
});
