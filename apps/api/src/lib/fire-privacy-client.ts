import { Logger } from "winston";
import { config } from "../config";
import {
  RedactPIIOptions,
  type RedactPIIEntity,
} from "../controllers/v2/types";
import { chunkMarkdown, type Chunk } from "./fire-privacy-chunker";

type FirePrivacyResponse = {
  redacted_text?: unknown;
  spans?: unknown;
  model_status?: unknown;
};

type RedactOptions = {
  text: string;
  url?: string;
  timeoutMs?: number;
  logger?: Logger;
  // Caller-provided config. Boolean form is normalized to a defaults
  // object via the Zod transform before reaching here; an unset value
  // wouldn't trigger this code path at all (transformer skips when
  // meta.options.redactPII is falsy).
  options?: RedactPIIOptions;
};

type RedactionSource = "model" | "heuristics" | "unknown";

type RedactionSpan = {
  start: number;
  end: number;
  entity?: RedactPIIEntity;
  kind: string;
  source: RedactionSource;
  score?: number;
};

type RedactionStatus = "ok" | "skipped" | "failed";

type RedactionReason =
  | "empty_input"
  | "too_large"
  | "upstream_skipped"
  | "service_unavailable"
  | "timeout"
  | "error";

type RedactionResult = {
  status: RedactionStatus;
  reason?: RedactionReason;
  redactedMarkdown: string | null;
  spans: RedactionSpan[];
  counts: Partial<Record<RedactPIIEntity, number>>;
};

// Mode + replaceStyle map to fire-privacy's `mode` and `operator` fields.
// Keep both sides in sync if either side changes.
const MODE_MAP = {
  accurate: "model",
  aggressive: "both",
  fast: "heuristics",
} as const;

const REPLACE_MAP = {
  tag: "replace",
  mask: "mask",
  remove: "redact",
} as const;

const DEFAULTS = {
  mode: "accurate",
  replaceStyle: "tag",
  language: "en",
} as const;

// Hard ceiling: above this byte count we refuse to redact and return
// `skipped` with reason `too_large` rather than ship partial results.
// Sized from `eval/scaling/` measurements in fire-privacy: 250KB ≈ ~80
// PDF pages, ~10 chunks, ~60s wall at c=3 with the model on. Anything
// larger pushes past the typical scrape budget and starves the fleet.
const MAX_REDACT_BYTES = 250_000;
// Chunks fan out at this concurrency to fire-privacy. The fleet has 6
// pods at saturation; c=3 keeps a single call under 50% of capacity so
// other tenants aren't starved.
const CHUNK_CONCURRENCY = 3;

// Maps a span's `kind` (as returned by either OPF or Presidio) onto the
// unified entity bucket used by redactPII options. Kinds we don't recognize
// fall through unmapped and drop when an entity allowlist is in play.
const KIND_TO_ENTITY: Record<string, RedactPIIEntity> = {
  // Person
  PRIVATE_PERSON: "PERSON",
  PERSON: "PERSON",
  // Email
  PRIVATE_EMAIL: "EMAIL",
  EMAIL_ADDRESS: "EMAIL",
  // Phone
  PRIVATE_PHONE: "PHONE",
  PHONE_NUMBER: "PHONE",
  PHONEIMEI: "PHONE",
  // Location
  PRIVATE_ADDRESS: "LOCATION",
  LOCATION: "LOCATION",
  // Financial
  ACCOUNT_NUMBER: "FINANCIAL",
  CREDIT_CARD: "FINANCIAL",
  IBAN_CODE: "FINANCIAL",
  US_BANK_NUMBER: "FINANCIAL",
  US_SSN: "FINANCIAL",
  US_ITIN: "FINANCIAL",
  CRYPTO: "FINANCIAL",
  // Secret
  SECRET: "SECRET",
  API_KEY: "SECRET",
  PASSWORD: "SECRET",
  US_DRIVER_LICENSE: "SECRET",
  US_PASSPORT: "SECRET",
  MEDICAL_LICENSE: "SECRET",
};

// Classify fire-privacy's per-span `source` string into an internal taxonomy.
// OPF spans always carry `openai-privacy-filter`; Presidio recognizer names
// end in `Recognizer`. Anything else is opaque.
function classifySource(raw: unknown): RedactionSource {
  if (typeof raw !== "string") return "unknown";
  if (raw === "openai-privacy-filter") return "model";
  if (raw.endsWith("Recognizer")) return "heuristics";
  return "unknown";
}

function coerceSpans(value: unknown): RedactionSpan[] {
  if (!Array.isArray(value)) return [];
  const out: RedactionSpan[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (
      typeof r.start !== "number" ||
      typeof r.end !== "number" ||
      typeof r.kind !== "string"
    ) {
      continue;
    }
    const entity = KIND_TO_ENTITY[r.kind];
    const span: RedactionSpan = {
      start: r.start,
      end: r.end,
      kind: r.kind,
      source: classifySource(r.source),
    };
    if (entity !== undefined) span.entity = entity;
    if (typeof r.score === "number") span.score = r.score;
    out.push(span);
  }
  return out;
}

// Apply an entity allowlist to the span set. When unset, returns the
// spans unchanged. When set, keeps only spans with a mapped `entity`
// that's in the allowlist — unmapped spans drop.
function filterByEntities(
  spans: RedactionSpan[],
  entities: readonly RedactPIIEntity[] | undefined,
): RedactionSpan[] {
  if (!entities || entities.length === 0) return spans;
  const allow = new Set(entities);
  return spans.filter(s => s.entity !== undefined && allow.has(s.entity));
}

// Re-render redacted text from the original + a filtered span set when
// fire-privacy's `redacted_text` no longer matches what we want to return
// (i.e. we narrowed the spans via entity filter). Same operator semantics
// as fire-privacy:
//   tag    → `<KIND>` placeholder per span
//   mask   → '*' × span length
//   remove → drop the chars entirely
function renderRedacted(
  text: string,
  spans: RedactionSpan[],
  replaceStyle: RedactPIIOptions["replaceStyle"],
): string {
  if (spans.length === 0) return text;
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const span of sorted) {
    if (span.start < cursor) continue; // overlap with prior span; skip
    if (span.start > text.length) break;
    out += text.slice(cursor, span.start);
    switch (replaceStyle) {
      case "tag":
        out += `<${span.kind}>`;
        break;
      case "mask":
        out += "*".repeat(Math.max(0, span.end - span.start));
        break;
      case "remove":
        break;
    }
    cursor = Math.min(span.end, text.length);
  }
  out += text.slice(cursor);
  return out;
}

function countByEntity(
  spans: RedactionSpan[],
): Partial<Record<RedactPIIEntity, number>> {
  const out: Partial<Record<RedactPIIEntity, number>> = {};
  for (const span of spans) {
    if (span.entity === undefined) continue;
    out[span.entity] = (out[span.entity] ?? 0) + 1;
  }
  return out;
}

// Result of one /redact call, in source-coordinate space (spans already
// offset by the chunk's start).
type ChunkResult =
  | {
      ok: true;
      spans: RedactionSpan[];
      redactedText: string;
      // Sticky upstream-skip flag: true if the model returned
      // model_status === "skipped" for this chunk. Surfaces on the
      // merged block when any chunk was skipped upstream.
      upstreamSkipped: boolean;
    }
  | { ok: false; reason: RedactionReason };

async function redactOnce(
  chunk: Chunk,
  options: RedactPIIOptions,
  url: string | undefined,
  timeoutMs: number,
  logger: Logger | undefined,
): Promise<ChunkResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${config.FIRE_PRIVACY_URL}/redact`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: chunk.text,
        mode: MODE_MAP[options.mode],
        operator: REPLACE_MAP[options.replaceStyle],
        language: DEFAULTS.language,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const reason: RedactionReason = timedOut ? "timeout" : "error";
    logger?.warn("fire-privacy request failed", {
      reason,
      url,
      mode: options.mode,
      chunkStart: chunk.start,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason };
  }
  clearTimeout(timer);

  if (!response.ok) {
    const reason: RedactionReason =
      response.status === 503 ? "service_unavailable" : "error";
    logger?.warn("fire-privacy returned non-2xx", {
      reason,
      httpStatus: response.status,
      url,
      mode: options.mode,
      chunkStart: chunk.start,
    });
    return { ok: false, reason };
  }

  let body: FirePrivacyResponse;
  try {
    body = (await response.json()) as FirePrivacyResponse;
  } catch (err) {
    logger?.warn("fire-privacy returned invalid JSON", {
      url,
      chunkStart: chunk.start,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: "error" };
  }

  const upstreamRedacted =
    typeof body.redacted_text === "string" ? body.redacted_text : null;
  const rawSpans = coerceSpans(body.spans);

  if (body.model_status === "error" || upstreamRedacted === null) {
    return { ok: false, reason: "error" };
  }

  // Lift spans into source coordinates.
  const spans = rawSpans.map(s => ({
    ...s,
    start: s.start + chunk.start,
    end: s.end + chunk.start,
  }));

  return {
    ok: true,
    spans,
    redactedText: upstreamRedacted,
    upstreamSkipped: body.model_status === "skipped",
  };
}

// Run chunks against fire-privacy with bounded concurrency. Returns
// results in chunk order (results[i] corresponds to chunks[i]).
async function runChunks(
  chunks: Chunk[],
  options: RedactPIIOptions,
  url: string | undefined,
  timeoutMs: number,
  logger: Logger | undefined,
): Promise<ChunkResult[]> {
  const results = new Array<ChunkResult>(chunks.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= chunks.length) return;
      results[i] = await redactOnce(chunks[i], options, url, timeoutMs, logger);
    }
  };

  const workers = Array.from(
    { length: Math.min(CHUNK_CONCURRENCY, chunks.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

export async function redactText(
  opts: RedactOptions,
): Promise<RedactionResult> {
  const { text, logger } = opts;
  const timeoutMs = opts.timeoutMs ?? config.FIRE_PRIVACY_TIMEOUT_MS;
  const options: RedactPIIOptions = opts.options ?? {
    mode: DEFAULTS.mode,
    replaceStyle: DEFAULTS.replaceStyle,
  };

  // Fire-privacy is an optional service. If it's not configured for this
  // deployment, surface a clear `failed/error` block rather than making
  // a request to `undefined/redact` and letting it fail opaquely.
  if (!config.FIRE_PRIVACY_URL) {
    logger?.warn("redactPII requested but FIRE_PRIVACY_URL is not configured", {
      url: opts.url,
    });
    return {
      status: "failed",
      reason: "error",
      redactedMarkdown: null,
      spans: [],
      counts: {},
    };
  }

  // Empty/whitespace input is a no-op locally — saves a round trip and matches
  // fire-privacy's own "skipped" semantics. We pass the original text through
  // as `redactedMarkdown` since there's nothing to remove.
  if (text.trim().length === 0) {
    return {
      status: "skipped",
      reason: "empty_input",
      redactedMarkdown: text,
      spans: [],
      counts: {},
    };
  }

  // Hard byte ceiling. Anything above this is refused with a dedicated
  // reason so callers can tell "we declined" apart from "we tried and
  // it broke." We measure bytes, not chars, because fire-privacy's
  // request cap is byte-based.
  const inputBytes = new TextEncoder().encode(text).length;
  if (inputBytes > MAX_REDACT_BYTES) {
    logger?.info("fire-privacy input exceeds redaction ceiling", {
      url: opts.url,
      inputBytes,
      maxBytes: MAX_REDACT_BYTES,
    });
    return {
      status: "skipped",
      reason: "too_large",
      redactedMarkdown: null,
      spans: [],
      counts: {},
    };
  }

  const chunks = chunkMarkdown(text);
  const results = await runChunks(chunks, options, opts.url, timeoutMs, logger);

  // All-or-nothing: any chunk failure poisons the whole response. Partial
  // redaction is worse than no redaction — callers can't tell which
  // sections of their markdown are clean. Pick the first non-ok reason
  // so the failure surface (timeout / service_unavailable / error) is
  // preserved end-to-end.
  const firstFailure = results.find(r => !r.ok);
  if (firstFailure && !firstFailure.ok) {
    return {
      status: "failed",
      reason: firstFailure.reason,
      redactedMarkdown: null,
      spans: [],
      counts: {},
    };
  }

  const successes = results.filter(
    (r): r is Extract<ChunkResult, { ok: true }> => r.ok,
  );

  // Merge: spans already lifted into source coordinates by redactOnce.
  const allSpans = successes.flatMap(r => r.spans);
  const spans = filterByEntities(allSpans, options.entities);

  // Re-render when the entity filter pruned spans OR when we have
  // multiple chunks (per-chunk redacted_text concatenations are valid
  // since chunks are non-overlapping, but re-rendering with the same
  // operator yields identical output and keeps one code path for the
  // edge cases — e.g. chunk boundaries inside a span are impossible
  // by construction since spans are produced after we split).
  const concatRedacted = successes.map(r => r.redactedText).join("");
  const redactedMarkdown =
    spans.length === allSpans.length
      ? concatRedacted
      : renderRedacted(text, spans, options.replaceStyle);

  const upstreamSkipped = successes.some(r => r.upstreamSkipped);

  if (upstreamSkipped) {
    return {
      status: "skipped",
      reason: "upstream_skipped",
      redactedMarkdown,
      spans,
      counts: countByEntity(spans),
    };
  }

  return {
    status: "ok",
    redactedMarkdown,
    spans,
    counts: countByEntity(spans),
  };
}
