/** Analytics job-log queries are disabled in core test runs. */
export const HAS_JOB_LOG = false;

export async function jobLogRows<T extends Record<string, unknown>>(
  _table: string,
  _where: string,
  _params: Record<string, string | number>,
  _options: { orderBy?: string; limit?: number } = {},
): Promise<T[]> {
  throw new Error("Analytics job log is not configured in this build");
}

export async function waitForJobLogRows<T extends Record<string, unknown>>(
  _table: string,
  _where: string,
  _params: Record<string, string | number>,
  _options: { orderBy?: string; limit?: number; min?: number } = {},
  _timeoutMs = 30000,
): Promise<T[]> {
  throw new Error("Analytics job log is not configured in this build");
}

export async function waitForJobLogRow<T extends Record<string, unknown>>(
  _table: string,
  _where: string,
  _params: Record<string, string | number>,
  _timeoutMs = 30000,
): Promise<T | null> {
  throw new Error("Analytics job log is not configured in this build");
}

/** Parses a job log JSON column; empty or malformed text reads as null. */
export function jobLogJson(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
