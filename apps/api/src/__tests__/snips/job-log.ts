import { isJsonObject } from "../../lib/json-types";
import type { JsonValue } from "../../lib/json-types";

/** Analytics job-log queries are disabled in core test runs. */
export const HAS_JOB_LOG = false;

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(
      (item: unknown) => item === undefined || isJsonValue(item),
    );
  }
  if (isJsonObject(value)) {
    return Object.values(value).every(
      item => item === undefined || isJsonValue(item),
    );
  }
  return false;
}

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
    return isJsonValue(value) ? value : null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return isJsonValue(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
