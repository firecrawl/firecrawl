import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { Watcher } from "../../../v2/watcher";

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  protocols?: string | string[];
  binaryType?: string;
  onmessage: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  closed = false;

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    MockWebSocket.instances.push(this);
  }

  close() {
    this.closed = true;
    if (this.onclose) this.onclose({} as any);
  }

  sendMessage(data: any) {
    if (this.onmessage) {
      this.onmessage({ data: JSON.stringify(data) });
    }
  }
}

describe("Watcher - issue #4223 catchup completed guard", () => {
  let originalWebSocket: any;

  beforeEach(() => {
    MockWebSocket.instances = [];
    originalWebSocket = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = MockWebSocket;
  });

  afterEach(() => {
    (globalThis as any).WebSocket = originalWebSocket;
  });

  test("does not prematurely emit done or close when catchup reports completed with 0 total and 0 completed", async () => {
    const mockHttp = {
      getApiUrl: () => "https://api.firecrawl.dev",
      getApiKey: () => "test-key",
      get: vi.fn().mockResolvedValue({
        status: 200,
        data: {
          success: true,
          status: "scraping",
          total: 1,
          completed: 0,
          data: [],
        },
      }),
    } as any;

    const watcher = new Watcher(mockHttp, "crawl-123", { pollInterval: 0.1 });
    let doneEmitted = false;
    let donePayload: any = null;
    const snapshots: any[] = [];
    const documents: any[] = [];

    watcher.on("snapshot", (s) => snapshots.push(s));
    watcher.on("document", (d) => documents.push(d));
    watcher.on("done", (d) => {
      doneEmitted = true;
      donePayload = d;
    });

    // Start the watcher
    const startPromise = watcher.start();

    expect(MockWebSocket.instances.length).toBe(1);
    const ws = MockWebSocket.instances[0]!;

    // Server sends offending catchup frame: completed with 0 total, 0 completed
    ws.sendMessage({
      type: "catchup",
      data: {
        success: true,
        status: "completed",
        total: 0,
        completed: 0,
        creditsUsed: 0,
        expiresAt: "2026-08-01T11:28:25.000Z",
        data: [],
      },
    });

    // Snapshot was emitted
    expect(snapshots.length).toBe(1);
    expect(snapshots[0].status).toBe("completed");

    // But done was NOT emitted and socket is NOT closed
    expect(doneEmitted).toBe(false);
    expect(ws.closed).toBe(false);

    // Later, actual document arrives over WebSocket
    ws.sendMessage({
      type: "document",
      data: {
        url: "https://example.com/page1",
        markdown: "# Page 1",
      },
    });

    expect(documents.length).toBe(1);
    expect(documents[0].url).toBe("https://example.com/page1");

    // Finally, server sends done frame over WebSocket
    ws.sendMessage({
      type: "done",
      data: {
        status: "completed",
        total: 1,
        completed: 1,
        creditsUsed: 1,
        data: [{ url: "https://example.com/page1", markdown: "# Page 1" }],
      },
    });

    // Now done should be emitted
    expect(doneEmitted).toBe(true);
    expect(donePayload.status).toBe("completed");
    expect(donePayload.total).toBe(1);
    expect(donePayload.completed).toBe(1);
    expect(ws.closed).toBe(true);

    await startPromise;
  });

  test("emits done immediately when catchup frame reports completed with documents/total > 0", async () => {
    const mockHttp = {
      getApiUrl: () => "https://api.firecrawl.dev",
      getApiKey: () => "test-key",
      get: vi.fn(),
    } as any;

    const watcher = new Watcher(mockHttp, "crawl-456");
    let donePayload: any = null;

    watcher.on("done", (d) => {
      donePayload = d;
    });

    const startPromise = watcher.start();
    const ws = MockWebSocket.instances[0]!;

    // Catchup frame for already completed job with total > 0
    ws.sendMessage({
      type: "catchup",
      data: {
        success: true,
        status: "completed",
        total: 2,
        completed: 2,
        data: [{ url: "https://example.com/1" }, { url: "https://example.com/2" }],
      },
    });

    expect(donePayload).not.toBeNull();
    expect(donePayload.status).toBe("completed");
    expect(donePayload.total).toBe(2);
    expect(donePayload.completed).toBe(2);
    expect(ws.closed).toBe(true);

    await startPromise;
  });

  test("falls back to REST and emits done when crawl genuinely completed with 0 documents", async () => {
    const mockHttp = {
      getApiUrl: () => "https://api.firecrawl.dev",
      getApiKey: () => "test-key",
      get: vi.fn().mockResolvedValue({
        status: 200,
        data: {
          success: true,
          status: "completed",
          total: 0,
          completed: 0,
          data: [],
        },
      }),
    } as any;

    const watcher = new Watcher(mockHttp, "crawl-789", { pollInterval: 0.05 });
    let donePayload: any = null;

    watcher.on("done", (d) => {
      donePayload = d;
    });

    const startPromise = watcher.start();
    const ws = MockWebSocket.instances[0]!;

    // Initial catchup frame
    ws.sendMessage({
      type: "catchup",
      data: {
        success: true,
        status: "completed",
        total: 0,
        completed: 0,
        data: [],
      },
    });

    // Wait for REST polling to confirm
    await startPromise;

    expect(donePayload).not.toBeNull();
    expect(donePayload.status).toBe("completed");
    expect(donePayload.total).toBe(0);
    expect(donePayload.completed).toBe(0);
    expect(mockHttp.get).toHaveBeenCalled();
  });
});
