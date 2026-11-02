import { Meta } from "..";
import { Document } from "../../../controllers/v2/types";
import { hasFormatOfType } from "../../../lib/format-utils";
import { eq } from "drizzle-orm";
import { db, dbRr } from "../../../db/connection";
import * as schema from "../../../db/schema";
import { extractDeterministicJson } from "../../../lib/deterministicJson/extract";
import type { CacheBackend } from "../../../lib/deterministicJson/core/cache";
import { flareSandboxRunner } from "../../../lib/deterministicJson/sandbox/flare";

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

  const sandbox = flareSandboxRunner();
  if (!sandbox) {
    warn("Deterministic JSON mode is not configured on this instance.");
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
      sandbox,
      costTracking: meta.costTracking,
    });
  } catch (error) {
    meta.logger.error("Deterministic JSON extraction failed", { error });
    warn("Deterministic JSON extraction failed.");
  }

  return document;
}
