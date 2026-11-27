import { z } from "zod";
import { logger } from "./logger";

const WINDOW_MS = 60_000;
const MAX_THROTTLE_ENTRIES = 500;
const MAX_ISSUES_LOGGED = 5;
const MAX_EXPAND_STEPS = 128;
const SAFE_PATH_SEGMENT_RE = /^[a-zA-Z0-9_-]{1,40}$/;

interface ThrottleEntry {
  lastLoggedAt: number;
  suppressedCount: number;
}

interface SanitizedIssue {
  code: string;
  path: string;
}

interface MismatchLogMeta {
  module: "zod-log";
  schemaTag: string;
  issueCount: number;
  suppressedCount: number;
  issues: Array<SanitizedIssue>;
  throttleOverflow?: true;
}

const throttleMap = new Map<string, ThrottleEntry>();
let overflowThrottle: ThrottleEntry | null = null;

function getInnerSchema(node: z.core.$ZodType): z.core.$ZodType | null {
  if (
    node instanceof z.core.$ZodOptional ||
    node instanceof z.core.$ZodNullable ||
    node instanceof z.core.$ZodDefault ||
    node instanceof z.core.$ZodPrefault ||
    node instanceof z.core.$ZodCatch ||
    node instanceof z.core.$ZodNonOptional ||
    node instanceof z.core.$ZodReadonly ||
    node instanceof z.core.$ZodPromise ||
    node instanceof z.core.$ZodSuccess
  ) {
    return node._zod.def.innerType;
  }
  if (node instanceof z.core.$ZodLazy) {
    return node._zod.def.getter();
  }
  return null;
}

function expandSchemas(
  schemas: ReadonlyArray<z.core.$ZodType>,
): Array<z.core.$ZodType> {
  const stack: Array<z.core.$ZodType> = [...schemas];
  const visited = new Set<z.core.$ZodType>();
  const expanded: Array<z.core.$ZodType> = [];
  let steps = 0;

  while (stack.length > 0 && steps < MAX_EXPAND_STEPS) {
    const node = stack.pop();
    if (node === undefined || visited.has(node)) {
      continue;
    }
    visited.add(node);
    steps += 1;

    const inner = getInnerSchema(node);
    if (inner !== null) {
      stack.push(inner);
      continue;
    }
    if (node instanceof z.core.$ZodUnion) {
      for (const option of node._zod.def.options) {
        stack.push(option);
      }
      continue;
    }
    if (node instanceof z.core.$ZodIntersection) {
      stack.push(node._zod.def.left, node._zod.def.right);
      continue;
    }
    if (node instanceof z.core.$ZodPipe) {
      stack.push(node._zod.def.in, node._zod.def.out);
      continue;
    }

    expanded.push(node);
  }

  return expanded;
}

// Keep only static z.object shape keys; redact dynamic z.record, catchall,
// and unrecognized keys so user-supplied identifiers never reach logs.
function sanitizePath(
  rootSchema: z.core.$ZodType,
  path: ReadonlyArray<PropertyKey>,
): string {
  let current: Array<z.core.$ZodType> = [rootSchema];
  const segments: Array<string> = [];

  for (const segment of path) {
    const expanded = expandSchemas(current);
    const next: Array<z.core.$ZodType> = [];

    if (typeof segment === "number") {
      segments.push("[]");
      for (const node of expanded) {
        if (node instanceof z.core.$ZodArray) {
          next.push(node._zod.def.element);
        } else if (node instanceof z.core.$ZodTuple) {
          const item =
            Number.isInteger(segment) &&
            segment >= 0 &&
            segment < node._zod.def.items.length
              ? node._zod.def.items[segment]
              : node._zod.def.rest;
          if (item !== null && item !== undefined) {
            next.push(item);
          }
        } else if (
          node instanceof z.core.$ZodSet ||
          node instanceof z.core.$ZodMap ||
          node instanceof z.core.$ZodRecord
        ) {
          next.push(node._zod.def.valueType);
        }
      }
      current = next;
      continue;
    }

    if (typeof segment !== "string") {
      segments.push("<key>");
      current = [];
      continue;
    }

    let isStaticSchemaKey = false;
    for (const node of expanded) {
      if (node instanceof z.core.$ZodObject) {
        const { shape, catchall } = node._zod.def;
        if (Object.hasOwn(shape, segment)) {
          isStaticSchemaKey = true;
          next.push(shape[segment]);
        } else if (catchall !== undefined) {
          next.push(catchall);
        }
      } else if (
        node instanceof z.core.$ZodRecord ||
        node instanceof z.core.$ZodMap
      ) {
        next.push(node._zod.def.valueType);
      }
    }

    segments.push(
      isStaticSchemaKey && SAFE_PATH_SEGMENT_RE.test(segment)
        ? segment
        : "<key>",
    );
    current = next;
  }

  return segments.join(".");
}

function logSchemaMismatch(
  schema: z.core.$ZodType,
  tag: string,
  rawIssues: ReadonlyArray<z.core.$ZodIssue>,
): void {
  try {
    const issues: Array<SanitizedIssue> = rawIssues
      .slice(0, MAX_ISSUES_LOGGED)
      .map(issue => ({
        code: issue.code,
        path: sanitizePath(schema, issue.path),
      }));
    const firstCode = issues[0]?.code ?? "unknown";
    const firstPath = issues[0]?.path ?? "";
    const key = `${tag}:${firstCode}:${firstPath}`;
    const now = Date.now();
    const existing = throttleMap.get(key);
    let suppressedCount = 0;
    let throttleOverflow = false;

    if (existing !== undefined) {
      if (now - existing.lastLoggedAt < WINDOW_MS) {
        existing.suppressedCount += 1;
        return;
      }
      suppressedCount = existing.suppressedCount;
      existing.lastLoggedAt = now;
      existing.suppressedCount = 0;
      throttleMap.delete(key);
      throttleMap.set(key, existing);
    } else {
      while (throttleMap.size >= MAX_THROTTLE_ENTRIES) {
        const oldest = throttleMap.entries().next();
        if (oldest.done || now - oldest.value[1].lastLoggedAt < WINDOW_MS) {
          break;
        }
        throttleMap.delete(oldest.value[0]);
      }

      if (throttleMap.size >= MAX_THROTTLE_ENTRIES) {
        if (
          overflowThrottle !== null &&
          now - overflowThrottle.lastLoggedAt < WINDOW_MS
        ) {
          overflowThrottle.suppressedCount += 1;
          return;
        }
        suppressedCount = overflowThrottle?.suppressedCount ?? 0;
        overflowThrottle = { lastLoggedAt: now, suppressedCount: 0 };
        throttleOverflow = true;
      } else {
        throttleMap.set(key, { lastLoggedAt: now, suppressedCount: 0 });
      }
    }

    const meta: MismatchLogMeta = {
      module: "zod-log",
      schemaTag: tag,
      issueCount: rawIssues.length,
      suppressedCount,
      issues,
    };
    if (throttleOverflow) {
      meta.throttleOverflow = true;
    }
    logger.warn("Zod schema mismatch", meta);
  } catch {
    // Logging must never break schema parsing.
  }
}

/**
 * Runs `schema.safeParse(value)` and emits a rate-limited, ZDR-safe warning
 * when validation fails, returning the parse result unchanged.
 */
export function safeParseLogged<T extends z.ZodType>(
  schema: T,
  value: unknown,
  tag: string,
): z.ZodSafeParseResult<z.output<T>> {
  const result = schema.safeParse(value);
  if (!result.success) {
    logSchemaMismatch(schema, tag, result.error.issues);
  }
  return result;
}

/**
 * Wraps a Zod schema with a fallback value while emitting a rate-limited,
 * ZDR-safe warning when the catch callback fires on a genuine shape mismatch.
 */
export function zCatchLogged<T extends z.ZodType>(
  schema: T,
  fallback: z.output<T>,
  tag: string,
): z.ZodCatch<T> {
  return z.catch(schema, ctx => {
    logSchemaMismatch(schema, tag, ctx.error.issues);
    return fallback;
  });
}
