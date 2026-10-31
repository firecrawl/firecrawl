import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({
  FIRE_PRIVACY_URL: undefined as string | undefined,
  FIRE_PRIVACY_TIMEOUT_MS: 50,
}));
vi.mock("../config", () => ({ config: settings }));
import { redactText } from "./fire-privacy-client";

describe("fire-privacy response body deadline", () => {
  for (const mode of [
    "stalled",
    "success",
    "invalid",
    "unavailable",
    "unavailable-stalled",
  ] as const) {
    it(`handles a native HTTP ${mode} response`, async () => {
      let responseClosed: (() => void) | undefined;
      const closed = new Promise<void>(resolve => {
        responseClosed = resolve;
      });
      const server = createServer((_req, res) => {
        res.once("close", () => responseClosed?.());
        res.statusCode = mode.startsWith("unavailable") ? 503 : 200;
        res.setHeader("content-type", "application/json");
        if (mode === "stalled" || mode === "unavailable-stalled") {
          res.flushHeaders();
          res.write('{"redacted_text":');
        } else if (mode === "success") {
          res.end(
            JSON.stringify({
              redacted_text: "redacted",
              spans: [],
              model_status: "ok",
            }),
          );
        } else if (mode === "invalid") {
          res.end("not JSON");
        } else {
          res.end();
        }
      });
      await new Promise<void>(resolve =>
        server.listen(0, "127.0.0.1", resolve),
      );
      settings.FIRE_PRIVACY_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      let guard: ReturnType<typeof setTimeout> | undefined;
      const started = performance.now();
      const pending = redactText({ text: "owned input", timeoutMs: 50 });
      try {
        const out = await Promise.race([
          pending,
          new Promise<never>((_resolve, reject) => {
            guard = setTimeout(
              () => reject(new Error("body exceeded consumer deadline")),
              300,
            );
          }),
        ]);
        if (mode === "success") {
          expect(out.status).toBe("ok");
          expect(out.redactedMarkdown).toBe("redacted");
        } else {
          expect(out.status).toBe("failed");
          expect(out.reason).toBe(
            mode === "stalled"
              ? "timeout"
              : mode.startsWith("unavailable")
                ? "service_unavailable"
                : "error",
          );
        }
        if (mode === "stalled") {
          const elapsed = performance.now() - started;
          expect(elapsed).toBeGreaterThanOrEqual(35);
          expect(elapsed).toBeLessThan(150);
        }
        if (mode === "unavailable-stalled") {
          await Promise.race([
            closed,
            new Promise<never>((_resolve, reject) => {
              clearTimeout(guard);
              guard = setTimeout(
                () => reject(new Error("error response body remains pinned")),
                150,
              );
            }),
          ]);
        }
      } finally {
        clearTimeout(guard);
        settings.FIRE_PRIVACY_URL = undefined;
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close(err => (err ? reject(err) : resolve())),
        );
        await pending;
      }
    });
  }
});
