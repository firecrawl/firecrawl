import type { HttpClient } from "../utils/httpClient";
import { SdkError, type Document, type PaginationConfig } from "../types";

export interface PaginatedFetchResult<T> {
  documents: T[];
  /** Unconsumed cursor when a caller limit stopped pagination early; null when fully drained. */
  next: string | null;
}

/**
 * Follows `next` URLs and aggregates paginated result arrays.
 * Throws on a failed page fetch so callers never get silent partial data.
 */
export async function fetchAllPages<T = Document>(
  http: HttpClient,
  nextUrl: string,
  initial: T[],
  pagination?: PaginationConfig
): Promise<PaginatedFetchResult<T>> {
  const docs = initial.slice();
  let current: string | null = nextUrl;
  let pageCount = 0;
  const maxPages = pagination?.maxPages ?? undefined;
  const maxResults = pagination?.maxResults ?? undefined;
  const maxWaitTime = pagination?.maxWaitTime ?? undefined;
  const started = Date.now();

  while (current) {
    if (maxPages != null && pageCount >= maxPages) break;
    if (maxWaitTime != null && (Date.now() - started) / 1000 > maxWaitTime) break;

    type PagePayload = { success: boolean; next?: string | null; data?: T[] | { pages?: T[]; next?: string | null } };
    let payload: PagePayload;
    try {
      const res = await http.get<PagePayload>(current);
      payload = res.data;
    } catch (err: any) {
      throw new SdkError(
        `Failed to fetch results page ${pageCount + 1} during pagination: ${err?.message ?? String(err)}`,
        err?.response?.status,
        "PAGINATION_FETCH_FAILED",
      );
    }
    if (!payload?.success) {
      throw new SdkError(
        `Results page ${pageCount + 1} returned an unsuccessful response during pagination`,
        undefined,
        "PAGINATION_FETCH_FAILED",
      );
    }

    const pageData = Array.isArray(payload.data)
      ? payload.data
      : payload.data?.pages || [];
    const pageNext = (payload.next ?? (Array.isArray(payload.data) ? null : payload.data?.next) ?? null) as string | null;
    for (const d of pageData) {
      if (maxResults != null && docs.length >= maxResults) break;
      docs.push(d as T);
    }
    if (maxResults != null && docs.length >= maxResults) {
      return { documents: docs, next: pageNext };
    }
    current = pageNext;
    pageCount += 1;
  }
  return { documents: docs, next: current ?? null };
}
