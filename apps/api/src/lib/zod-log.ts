import { z } from "zod";
import { logger } from "./logger";

const WINDOW_MS = 60_000;
const MAX_THROTTLE_ENTRIES = 500;
const MAX_ISSUES_LOGGED = 5;
const SAFE_PATH_SEGMENT_RE = /^[a-zA-Z0-9_-]{1,40}$/;

interface ThrottleEntry {
  lastLoggedAt: number;
  suppressedCount: number;
}

interface SanitizedIssue {
  code: string;
  path: string;
}

const throttleMap = new Map<string, ThrottleEntry>();

function sanitizePathSegment(segment: PropertyKey): string {
  if (typeof segment === "number") {
    return "[]";
  }
  if (typeof segment === "string" && SAFE_PATH_SEGMENT_RE.test(segment)) {
    return segment;
  }
  return "<key>";
}

function sanitizePath(path: ReadonlyArray<PropertyKey>): string {
  return path.map(sanitizePathSegment).join(".");
}

function logSchemaMismatch(
  tag: string,
  rawIssues: ReadonlyArray<z.core.$ZodIssue>,
): void {
  try {
    const issues: Array<SanitizedIssue> = rawIssues
      .slice(0, MAX_ISSUES_LOGGED)
      .map(issue => ({
        code: issue.code,
        path: sanitizePath(issue.path),
      }));
    const firstCode = issues[0]?.code ?? "unknown";
    const firstPath = issues[0]?.path ?? "";
    const key = `${tag}:${firstCode}:${firstPath}`;
    const now = Date.now();
    const existing = throttleMap.get(key);

    if (existing !== undefined) {
      if (now - existing.lastLoggedAt < WINDOW_MS) {
        existing.suppressedCount += 1;
        return;
      }
      const suppressedCount = existing.suppressedCount;
      existing.lastLoggedAt = now;
      existing.suppressedCount = 0;
      throttleMap.delete(key);
      throttleMap.set(key, existing);
      logger.warn("Zod schema mismatch", {
        module: "zod-log",
        schemaTag: tag,
        issueCount: rawIssues.length,
        suppressedCount,
        issues,
      });
      return;
    }

    if (throttleMap.size >= MAX_THROTTLE_ENTRIES) {
      for (const [entryKey, entry] of throttleMap) {
        if (now - entry.lastLoggedAt >= WINDOW_MS) {
          throttleMap.delete(entryKey);
        }
      }
      if (throttleMap.size >= MAX_THROTTLE_ENTRIES) {
        const oldest = throttleMap.keys().next();
        if (!oldest.done) {
          throttleMap.delete(oldest.value);
        }
      }
    }

    throttleMap.set(key, { lastLoggedAt: now, suppressedCount: 0 });
    logger.warn("Zod schema mismatch", {
      module: "zod-log",
      schemaTag: tag,
      issueCount: rawIssues.length,
      suppressedCount: 0,
      issues,
    });
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
    logSchemaMismatch(tag, result.error.issues);
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
    logSchemaMismatch(tag, ctx.error.issues);
    return fallback;
  });
}
