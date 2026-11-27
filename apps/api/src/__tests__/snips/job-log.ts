import { inMemoryJsonValueSchema, jsonValueSchema } from "../../lib/json-types";
import type { JsonValue } from "../../lib/json-types";

/** Analytics job-log queries are disabled in core test runs. */
export const HAS_JOB_LOG = false;

export async function jobLogRows<T extends Record<string, unknown>>(
  _table: string,
  _where: string,
  _params: Record<string, string | number>,
  _options: { orderBy?: string; limit?: number } = {},
): Promise<Array<T>> {
  throw new Error("Analytics job log is not configured in this build");
}

export async function waitForJobLogRows<T extends Record<string, unknown>>(
  _table: string,
  _where: string,
  _params: Record<string, string | number>,
  _options: { orderBy?: string; limit?: number; min?: number } = {},
  _timeoutMs = 30_000,
): Promise<Array<T>> {
  throw new Error("Analytics job log is not configured in this build");
}

export async function waitForJobLogRow<T extends Record<string, unknown>>(
  _table: string,
  _where: string,
  _params: Record<string, string | number>,
  _timeoutMs = 30_000,
): Promise<T | null> {
  throw new Error("Analytics job log is not configured in this build");
}

/** Parses a job log JSON column; empty or malformed text reads as null. */
export function jobLogJson(value: unknown): JsonValue {
  if (typeof value !== "string") {
    if (value === undefined) {
      return null;
    }
    const parsed = inMemoryJsonValueSchema.safeParse(value);
    return parsed.success && parsed.data !== undefined ? parsed.data : null;
  }
  try {
    const raw: unknown = JSON.parse(value);
    const parsed = jsonValueSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
