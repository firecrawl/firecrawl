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
    }
  });
});
