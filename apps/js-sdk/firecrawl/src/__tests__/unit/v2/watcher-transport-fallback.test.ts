import { describe, test, expect, jest } from "@jest/globals";
import { Watcher } from "../../../v2/watcher";

describe("watcher WebSocket transport failure", () => {
  test("continues a crawl by polling when the WebSocket errors", async () => {
    class TestWebSocket {
      static instance: TestWebSocket;
      onerror?: () => void;
      onclose?: () => void;
      binaryType = "blob";

      constructor() {
        TestWebSocket.instance = this;
      }

      close() {
        this.onclose?.();
      }
    }

    const originalWebSocket = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = TestWebSocket;
    try {
      const http = {
        getApiUrl: () => "https://api.firecrawl.dev",
        getApiKey: () => "test-key",
        get: jest.fn(async () => ({
          status: 200,
          data: {
            success: true,
            status: "completed",
            completed: 1,
            total: 1,
            data: [{ markdown: "finished" }],
          },
        })),
      };
      const watcher = new Watcher(http as any, "crawl-1");
      const done = jest.fn();
      const errors = jest.fn();
      watcher.on("done", done);
      watcher.on("error", errors);

      const running = watcher.start();
      await new Promise((resolve) => setImmediate(resolve));
      TestWebSocket.instance.onerror?.();
      await running;

      expect(errors).not.toHaveBeenCalled();
      expect(http.get).toHaveBeenCalledTimes(1);
      expect(done).toHaveBeenCalledWith(expect.objectContaining({
        status: "completed",
        data: [{ markdown: "finished" }],
      }));
    } finally {
      (globalThis as any).WebSocket = originalWebSocket;
      // Watcher caches the discovered constructor at module scope.
      jest.resetModules();
    }
  });

  test("keeps the original timeout deadline when switching to polling", async () => {
    class TestWebSocket {
      static instance: TestWebSocket;
      onerror?: () => void;
      onclose?: () => void;

      constructor() {
        TestWebSocket.instance = this;
      }

      close() {
        this.onclose?.();
      }
    }

    const originalWebSocket = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = TestWebSocket;
    const now = jest.spyOn(Date, "now").mockReturnValue(0);
    jest.resetModules();
    const { Watcher: IsolatedWatcher } = await import("../../../v2/watcher");
    const http = {
      getApiUrl: () => "https://api.firecrawl.dev",
      getApiKey: () => "test-key",
      get: jest.fn(async () => ({
        status: 200,
        data: { success: true, status: "processing", data: [] },
      })),
    };
    const watcher = new IsolatedWatcher(http as any, "crawl-2", { timeout: 0.5 });
    const errors = jest.fn();
    watcher.on("error", errors);
    try {
      const running = watcher.start();
      await new Promise((resolve) => setImmediate(resolve));
      now.mockReturnValue(1000);
      TestWebSocket.instance.onerror?.();

      const result = await Promise.race([
        running.then(() => "stopped"),
        new Promise<string>((resolve) => setTimeout(() => resolve("still-running"), 100)),
      ]);
      expect(result).toBe("stopped");
      expect(errors).toHaveBeenCalledWith(expect.objectContaining({ error: "Watcher timeout" }));
      expect(http.get).not.toHaveBeenCalled();
    } finally {
      watcher.close();
      now.mockRestore();
      (globalThis as any).WebSocket = originalWebSocket;
      jest.resetModules();
    }
  });
});
