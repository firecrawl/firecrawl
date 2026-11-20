import type { HttpClient } from "../utils/httpClient";
import type { Document, PaginationConfig } from "../types";

/**
 * Shared helper to follow `next` URLs and aggregate paginated result arrays.
 */
export async function fetchAllPages<T = Document>(
  http: HttpClient,
  nextUrl: string,
  initial: T[],
  pagination?: PaginationConfig
): Promise<T[]> {
  const docs = initial.slice();
  let current: string | null = nextUrl;
  let pageCount = 0;
  const maxPages = pagination?.maxPages ?? undefined;
  const maxResults = pagination?.maxResults ?? undefined;
  const maxWaitTime = pagination?.maxWaitTime ?? undefined;
  const started = Date.now();
  const visited = new Set<string>();

  // HttpClient pins every absolute cursor to the API origin; fragments are not sent in HTTP requests.
  // Match the path and query actually requested so aliases cannot return the same page twice.
  const cursorKey = (cursor: string): string => {
    try {
      const url = new URL(cursor, "https://pagination.invalid/");
      return url.pathname + url.search;
    } catch {
      return cursor;
    }
  };

  while (current) {
    if (maxPages != null && pageCount >= maxPages) break;
    if (maxWaitTime != null && (Date.now() - started) / 1000 > maxWaitTime) break;
    const key = cursorKey(current);
    if (visited.has(key)) break;
    visited.add(key);

    let payload: { success: boolean; next?: string | null; data?: T[] | { pages?: T[]; next?: string | null } } | null = null;
    try {
      const res = await http.get<{ success: boolean; next?: string | null; data?: T[] | { pages?: T[]; next?: string | null } }>(current);
      payload = res.data;
    } catch {
      break; // axios rejects on non-2xx; stop pagination gracefully
    }
    if (!payload?.success) break;

    const pageData = Array.isArray(payload.data)
      ? payload.data
      : payload.data?.pages || [];
    for (const d of pageData) {
      if (maxResults != null && docs.length >= maxResults) break;
      docs.push(d as T);
    }
    if (maxResults != null && docs.length >= maxResults) break;
    const next = (payload.next ?? (Array.isArray(payload.data) ? null : payload.data?.next) ?? null) as string | null;
    current = next;
    pageCount += 1;
  }
  return docs;
}


