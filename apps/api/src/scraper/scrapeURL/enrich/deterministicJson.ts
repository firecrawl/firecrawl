import WebSocket from "ws";
import { Meta } from "..";
import { Document } from "../../../controllers/v2/types";
import { hasFormatOfType } from "../../../lib/format-utils";
import { eq } from "drizzle-orm";
import { db, dbRr } from "../../../db/connection";
import * as schema from "../../../db/schema";
import { extractDeterministicJson } from "../../../lib/deterministicJson/extract";
import {
  CODE_SANDBOX_URL,
  SANDBOX_TIMEOUT_MS,
} from "../../../lib/deterministicJson/config";
import type { CacheBackend } from "../../../lib/deterministicJson/core/cache";
import type { SandboxRunner } from "../../../lib/deterministicJson/sandbox/runExtractor";

const cache: CacheBackend = {
  async getExtractor(key) {
    const [data] = await dbRr
      .select({
        code: schema.deterministic_json_scripts.code,
        created_at: schema.deterministic_json_scripts.created_at,
      })
      .from(schema.deterministic_json_scripts)
      .where(eq(schema.deterministic_json_scripts.cache_key, key))
      .limit(1);
    return data
      ? { code: data.code, createdAt: new Date(data.created_at).getTime() }
      : undefined;
  },
  async setExtractor(key, code, meta) {
    const now = new Date().toISOString();
    await db
      .insert(schema.deterministic_json_scripts)
      .values({
        cache_key: key,
        code,
        url: meta.url,
        model: meta.model,
        cache_version: meta.cacheVersion,
        updated_at: now,
        last_used_at: now,
      })
      .onConflictDoUpdate({
        target: schema.deterministic_json_scripts.cache_key,
        set: {
          code,
          url: meta.url,
          model: meta.model,
          cache_version: meta.cacheVersion,
          updated_at: now,
          last_used_at: now,
        },
      });
  },
  async getLlm(key) {
    const [data] = await dbRr
      .select({
        response: schema.deterministic_json_llm_cache.response,
        created_at: schema.deterministic_json_llm_cache.created_at,
      })
      .from(schema.deterministic_json_llm_cache)
      .where(eq(schema.deterministic_json_llm_cache.cache_key, key))
      .limit(1);
    return data
      ? {
          response: data.response,
          createdAt: new Date(data.created_at).getTime(),
        }
      : undefined;
  },
  async setLlm(key, response) {
    const now = new Date().toISOString();
    await db
      .insert(schema.deterministic_json_llm_cache)
      .values({ cache_key: key, response, last_used_at: now })
      .onConflictDoUpdate({
        target: schema.deterministic_json_llm_cache.cache_key,
        set: { response, last_used_at: now },
      });
  },
  async touch(key) {
    const now = new Date().toISOString();
    await Promise.all([
      db
        .update(schema.deterministic_json_scripts)
        .set({ last_used_at: now })
        .where(eq(schema.deterministic_json_scripts.cache_key, key)),
      db
        .update(schema.deterministic_json_llm_cache)
        .set({ last_used_at: now })
        .where(eq(schema.deterministic_json_llm_cache.cache_key, key)),
    ]);
  },
};

function sandboxRunner(endpoint: string): SandboxRunner {
  return job =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(endpoint);
      let done = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (err: Error | null, value?: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          /* closing */
        }
        err ? reject(err) : resolve(value);
      };
      timer = setTimeout(
        () =>
          finish(new Error(`sandbox timed out after ${SANDBOX_TIMEOUT_MS}ms`)),
        SANDBOX_TIMEOUT_MS,
      );
      ws.on("open", () =>
        ws.send(
          JSON.stringify({ type: "run", code: job.code, input: job.input }),
        ),
      );
      ws.on("message", async raw => {
        let frame: any;
        try {
          frame = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (frame.type === "host") {
          let value: unknown;
          let error: string | undefined;
          try {
            value = await job.onHost(frame.channel, frame.payload);
          } catch (err) {
            error = err instanceof Error ? err.message : String(err);
          }
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "hostResult",
                id: frame.id,
                value,
                error,
              }),
            );
          }
        } else if (frame.type === "result") {
          finish(null, frame.value);
        } else if (frame.type === "error") {
          finish(new Error(frame.message));
        }
      });
      ws.on("error", err =>
        finish(err instanceof Error ? err : new Error(String(err))),
      );
      ws.on("close", () => finish(new Error("sandbox connection closed")));
    });
}

export async function performDeterministicJson(
  meta: Meta,
  document: Document,
): Promise<Document> {
  const format = hasFormatOfType(meta.options.formats, "deterministicJson");
  if (!format) return document;

  const warn = (msg: string) => {
    document.warning = msg + (document.warning ? " " + document.warning : "");
  };

  if (meta.internalOptions.zeroDataRetention) {
    warn("Deterministic JSON mode is not supported with zero data retention.");
    return document;
  }

  const html = document.html ?? document.rawHtml;
  if (!html) {
    warn("Deterministic JSON mode requires page HTML.");
    return document;
  }

  try {
    document.json = await extractDeterministicJson({
      url: document.metadata?.sourceURL ?? meta.url,
      prompt: format.prompt ?? "",
      jsonSchema: (format.schema ?? {}) as Record<string, unknown>,
      page: { html, markdown: document.markdown ?? "" },
      cache,
      sandbox: sandboxRunner(CODE_SANDBOX_URL),
      costTracking: meta.costTracking,
    });
  } catch (error) {
    meta.logger.error("Deterministic JSON extraction failed", { error });
    warn("Deterministic JSON extraction failed.");
  }

  return document;
}
