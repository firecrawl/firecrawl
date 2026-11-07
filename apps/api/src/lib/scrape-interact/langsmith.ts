import * as ai from "ai";
import { config } from "../../config";
import { logger as _logger } from "../logger";

const logger = _logger.child({ module: "scrape-interact/langsmith" });

// Trim once at module load — a whitespace-only LANGSMITH_API_KEY would be
// truthy in JS, flip the gate on, and then every trace POST would silently
// 401 against LangSmith with no other signal that something's wrong.
const LANGSMITH_API_KEY = config.LANGSMITH_API_KEY?.trim() || undefined;

// Opt-in: require both a key AND explicit LANGSMITH_TRACING=true. Having a
// key alone shouldn't start shipping traces, since operators may set the key
// for local experimentation and be surprised when prod starts tracing too.
/** @public — consumed via dynamic require() in langsmith.test.ts */
export const isLangSmithEnabled = Boolean(
  LANGSMITH_API_KEY && config.LANGSMITH_TRACING === true,
);

export type InteractTraceMetadata = {
  thread_id: string;
  session_id: string;
  scrape_id: string;
  team_id: string;
  // Optional org_id below team_id for finer-grained LangSmith filtering — the
  // parent org when teams are grouped. Not always present; team_id is the only
  // guaranteed identity.
  org_id?: string;
  browser_id?: string;
  run_id?: string;
  mode: "prompt" | "code";
  // Context inherited from the upstream scrape that this interact session is
  // continuing. Interact extends scrape, so the agent's work only makes sense
  // alongside what the scrape set up: the target URL, how long it waited,
  // what pre-actions ran, and where the scrape was initiated. URLs are
  // normalized to origin+path (no query string) before being attached to
  // avoid leaking query-string PII into LangSmith.
  scrape_url?: string;
  target_url?: string;
  scrape_wait_for_ms?: number;
  scrape_actions?: number;
  scrape_origin?: string;
  // When true, the caller has determined the team/scrape is under
  // zero-data-retention and tracing must be skipped entirely so no prompt,
  // code, or tool I/O is shipped to LangSmith.
  zeroDataRetention?: boolean;
};

/**
 * Strip query string + fragment from a URL so it can safely go into trace
 * metadata. A plain split is used rather than `new URL()` so malformed inputs
 * can't slip through a `catch` branch still carrying `?token=...` fragments.
 */
export function sanitizeUrlForTrace(
  url: string | null | undefined,
): string | undefined {
  if (!url) return undefined;
  return url.split("?")[0].split("#")[0];
}

type WrappedAISDK = {
  generateText: typeof ai.generateText;
  streamText: typeof ai.streamText;
  generateObject: typeof ai.generateObject;
  streamObject: typeof ai.streamObject;
};

type LangSmithProviderOptions = {
  name?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
};

type TraceableOptions = {
  name?: string;
  run_type?:
    | "tool"
    | "chain"
    | "llm"
    | "retriever"
    | "embedding"
    | "prompt"
    | "parser";
  metadata?: Record<string, unknown>;
  tags?: string[];
};

type LangSmithProviderOptionsReturn = Record<string, unknown>;

let wrappedSDK: WrappedAISDK = ai;
let createLangSmithProviderOptionsFn:
  | ((opts: LangSmithProviderOptions) => LangSmithProviderOptionsReturn)
  | null = null;
let traceableFn:
  | (<F extends (...args: any[]) => any>(fn: F, opts?: TraceableOptions) => F)
  | null = null;

if (isLangSmithEnabled) {
  try {
    const vercelWrapper = require("langsmith/experimental/vercel");
    const traceableMod = require("langsmith/traceable");
    wrappedSDK = vercelWrapper.wrapAISDK(ai);
    createLangSmithProviderOptionsFn =
      vercelWrapper.createLangSmithProviderOptions;
    traceableFn = traceableMod.traceable;

    // Mirror our config into process.env only after the langsmith modules
    // loaded successfully. If init fails we fall back to the raw ai SDK
    // without polluting the process env for other modules. Use the trimmed
    // key so whitespace padding in .env can't reach the langsmith SDK.
    process.env.LANGSMITH_TRACING = "true";
    process.env.LANGSMITH_API_KEY = LANGSMITH_API_KEY!;
    if (config.LANGSMITH_PROJECT) {
      process.env.LANGSMITH_PROJECT = config.LANGSMITH_PROJECT;
    }
    if (config.LANGSMITH_ENDPOINT) {
      process.env.LANGSMITH_ENDPOINT = config.LANGSMITH_ENDPOINT;
    }

    logger.info("LangSmith tracing enabled for interact agent", {
      project: config.LANGSMITH_PROJECT ?? "(default)",
    });
  } catch (err) {
    logger.error(
      "Failed to initialize LangSmith — falling back to raw ai SDK",
      {
        error: err,
      },
    );
  }
}

/** @public — streamText/generateObject/streamObject consumed via dynamic require() in langsmith.test.ts */
export const { generateText, streamText, generateObject, streamObject } =
  wrappedSDK;

// The LangSmith provider config is recognized by wrapAISDK but is not a
// first-class AI SDK provider, so callers still need a narrow cast when
// assigning to AI SDK's typed `providerOptions`. We keep the helper's return
// type honest so the cast is local to the call site rather than `any`
// propagating back here.
export function buildLangSmithProviderOptions(
  meta: InteractTraceMetadata,
  opts: {
    name?: string;
    tags?: string[];
    extra?: Record<string, unknown>;
  } = {},
): LangSmithProviderOptionsReturn | undefined {
  if (
    !isLangSmithEnabled ||
    !createLangSmithProviderOptionsFn ||
    meta.zeroDataRetention
  ) {
    return undefined;
  }

  return createLangSmithProviderOptionsFn({
    name: opts.name,
    metadata: { ...meta, ...(opts.extra ?? {}) },
    tags: ["interact", `mode:${meta.mode}`, ...(opts.tags ?? [])],
  });
}

export function traceInteract<F extends (...args: any[]) => any>(
  fn: F,
  meta: InteractTraceMetadata,
  opts: { name?: string; runType?: TraceableOptions["run_type"] } = {},
): F {
  if (!isLangSmithEnabled || !traceableFn || meta.zeroDataRetention) return fn;

  return traceableFn(fn, {
    name: opts.name ?? `interact:${meta.mode}`,
    run_type: opts.runType ?? "chain",
    metadata: { ...meta },
    tags: ["interact", `mode:${meta.mode}`],
  });
}
