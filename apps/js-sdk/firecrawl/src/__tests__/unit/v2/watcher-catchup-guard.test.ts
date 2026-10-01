import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import { Watcher } from "../../../v2/watcher";

// Regression coverage for https://github.com/firecrawl/firecrawl/issues/4223:
// the server's initial `catchup` frame for a just-started crawl can report
// `status: "completed"` with `total: 0` and `completed: 0`. The watcher must
// not treat that self-contradictory snapshot as the end of the job.

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(_url: string, _protocols?: string | string[]) {
    FakeWebSocket.instances.push(this);
  }

  close() {
    // no-op
  }
}

const httpStub = {
  getApiUrl: () => "https://api.firecrawl.dev",
  getApiKey: () => "test-key",
} as any;

async function startWatcher() {
  FakeWebSocket.instances = [];
  (globalThis as any).WebSocket = FakeWebSocket;
  const watcher = new Watcher(httpStub, "job-1", { kind: "crawl" });
  const events: Array<[string, any]> = [];
  watcher.on("done", (payload: any) => events.push(["done", payload]));
  // Intentionally not awaited: start() resolves on done/error.
  watcher.start();
  await new Promise((r) => setTimeout(r, 10));
  const ws = FakeWebSocket.instances[0];
  if (!ws) throw new Error("watcher did not open a WebSocket");
  return { watcher, events, ws };
}

function sendFrame(ws: FakeWebSocket, frame: unknown) {
  ws.onmessage?.({ data: JSON.stringify(frame) } as any);
}

describe("watcher catchup guard (#4223)", () => {
  const realWebSocket = (globalThis as any).WebSocket;

  beforeEach(() => {
    (globalThis as any).WebSocket = undefined;
  });

  afterEach(() => {
    (globalThis as any).WebSocket = realWebSocket;
  });

  test("lying initial catchup (completed, total 0, completed 0) does not end the watch", async () => {
    const { watcher, events, ws } = await startWatcher();
    let pollStarted = false;
    (watcher as any).pollLoop = () => {
      pollStarted = true;
      return Promise.resolve();
    };

    sendFrame(ws, {
      type: "catchup",
      data: { success: true, status: "completed", total: 0, completed: 0, creditsUsed: 0, data: [] },
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(events.filter(([name]) => name === "done")).toHaveLength(0);
    expect((watcher as any).closed).toBe(false);
    expect(pollStarted).toBe(true);
    watcher.close();
  });

  test("honest completed catchup still ends the watch", async () => {
    const { watcher, events, ws } = await startWatcher();

    sendFrame(ws, {
      type: "catchup",
      data: { success: true, status: "completed", total: 3, completed: 3, creditsUsed: 3, data: [] },
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(events).toHaveLength(1);
    expect(events[0][1].status).toBe("completed");
    expect((watcher as any).closed).toBe(true);
  });

  test("failed snapshot with empty counters still ends the watch", async () => {
    const { watcher, events, ws } = await startWatcher();

    sendFrame(ws, {
      type: "catchup",
      data: { success: true, status: "failed", total: 0, completed: 0, data: [] },
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(events).toHaveLength(1);
    expect(events[0][1].status).toBe("failed");
    expect((watcher as any).closed).toBe(true);
  });
});
