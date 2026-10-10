import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";

vi.mock("../config", () => ({ config: {} }));
vi.mock("./logger", () => {
  const logger = { debug: vi.fn(), info: vi.fn(), error: vi.fn(), warn: vi.fn(), child: () => logger };
  return { logger };
});
import { SearchIndexClient } from "./search-index-client";

describe("search-index response body deadline", () => {
  for (const mode of ["stalled", "success", "invalid", "unavailable"] as const) {
    it(`handles a native HTTP ${mode} health response`, async () => {
      const server = createServer((_req, res) => {
        res.statusCode = mode === "unavailable" ? 503 : 200;
        res.setHeader("content-type", "application/json");
        if (mode === "stalled") {
          res.flushHeaders();
          res.write('{"success":');
        } else if (mode === "success") {
          res.end(JSON.stringify({ success: true }));
        } else if (mode === "invalid") {
          res.end("not JSON");
        } else {
          res.end(JSON.stringify({ error: "owned unavailable" }));
        }
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const client = new SearchIndexClient({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, timeout: 50 });
      let guard: ReturnType<typeof setTimeout> | undefined;
      const pending = client.health();
      try {
        const healthy = await Promise.race([
          pending,
          new Promise<never>((_resolve, reject) => { guard = setTimeout(() => reject(new Error("body exceeded consumer deadline")), 300); }),
        ]);
        expect(healthy).toBe(mode === "success");
      } finally {
        clearTimeout(guard);
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
        await pending;
      }
    });
  }
});
