import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
const settings = vi.hoisted(() => ({ FIRE_PRIVACY_URL: undefined as string | undefined, FIRE_PRIVACY_TIMEOUT_MS: 2000 }));
vi.mock("../config", () => ({ config: settings }));
import { redactText } from "./fire-privacy-client";
import { DEFAULT_MAX_CHARS } from "./fire-privacy-chunker";

describe("chunked text through a native UTF-8 service consumer", () => {
  for (const text of ["a".repeat(DEFAULT_MAX_CHARS - 1) + "🔒tail", "ordinary text"]) {
    it(`retains characters across ${text.length > DEFAULT_MAX_CHARS ? "multiple" : "single"} chunks`, async () => {
      const server = createServer(async (req, res) => {
        let encoded = "";
        for await (const piece of req) encoded += piece;
        const payload = JSON.parse(encoded);
        // Owned fixture's text consumer uses native UTF-8 conversion, which
        // replaces unpaired UTF-16 surrogates. No model inference is simulated.
        const text = Buffer.from(payload.text, "utf8").toString("utf8");
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ redacted_text: text, spans: [], model_status: "ok" }));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      settings.FIRE_PRIVACY_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      try {
        const out = await redactText({ text, timeoutMs: 2000 });
        expect(out.status).toBe("ok");
        expect(out.redactedMarkdown).toBe(text);
      } finally {
        settings.FIRE_PRIVACY_URL = undefined;
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
      }
    });
  }
});
