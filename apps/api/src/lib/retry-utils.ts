import { logger } from "./logger";
import { SearchUnavailableError } from "./error";

const RETRY_DELAYS = [500, 1500, 3000] as const;
const MAX_ATTEMPTS = RETRY_DELAYS.length + 1;

/**
 * Generic HTTP request function for Fire Engine API calls. `onFailure` gets
 * the response status of a non-2xx reply, or undefined when no reply arrived.
 */
export async function attemptRequest<T>(
  url: string,
  data: string,
  abort?: AbortSignal,
  requestId?: string,
  onFailure?: (status?: number) => void,
): Promise<T | null> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Disable-Cache": "true",
        ...(requestId ? { "X-Request-ID": requestId } : {}),
      },
      body: data,
      signal: abort,
    });

    if (response.ok) {
      return await response.json();
    } else {
      onFailure?.(response.status);
      // Log non-OK responses for better observability
      const statusText = response.statusText || "Unknown Error";
      let bodySnippet = "";
      try {
        const body = await response.text();
        bodySnippet = body.length > 200 ? body.substring(0, 200) + "..." : body;
      } catch {
        bodySnippet = "[Unable to read response body]";
      }

      logger.warn(`Fire Engine API returned ${response.status} ${statusText}`, {
        url,
        status: response.status,
        statusText,
        bodySnippet,
      });
    }
  } catch (error) {
    onFailure?.(undefined);
    logger.error("Fire Engine API request failed:", error);
  }
  return null;
}

/**
 * Abortable sleep function that resolves immediately if the signal is aborted
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    const timeoutId = setTimeout(() => {
      resolve();
    }, ms);

    const abortHandler = () => {
      clearTimeout(timeoutId);
      resolve();
    };

    signal?.addEventListener("abort", abortHandler, { once: true });
  });
}

/**
 * Generic retry utility that executes an operation with exponential backoff
 * @param operation - The async operation to retry
 * @param hasValidResult - Function to check if the result is valid/complete
 * @param signal - Optional AbortSignal to cancel the operation
 * @param maxAttempts - Maximum number of attempts (defaults to 4)
 * @param retryDelays - Array of delay times in ms between retries
 * @returns The result of the operation or null if all attempts fail
 */
export async function executeWithRetry<T>(
  operation: () => Promise<T | null>,
  hasValidResult: (result: T | null) => result is T,
  signal?: AbortSignal,
  maxAttempts: number = MAX_ATTEMPTS,
  retryDelays: readonly number[] = RETRY_DELAYS,
): Promise<T | null> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) break;

    try {
      const result = await operation();

      if (hasValidResult(result)) {
        return result;
      }
    } catch (error) {
      // Don't log or report expected abort errors to reduce noise
      if (error instanceof Error && error.name === "AbortError") {
        break;
      }

      logger.error(`Attempt ${attempt + 1} failed:`, error);
    }

    // Wait before retry (except on last attempt)
    if (attempt < retryDelays.length) {
      await abortableSleep(retryDelays[attempt], signal);
    }
  }

  return null;
}

/**
 * POSTs a search request to fire-engine. A 5xx or network failure is retried
 * once and then throws SearchUnavailableError; a 4xx returns null.
 */
export async function requestSearchBackend<T>(
  url: string,
  data: string,
  abort?: AbortSignal,
  requestId?: string,
): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await abortableSleep(500, abort);
    if (abort?.aborted) return null;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Disable-Cache": "true",
          ...(requestId ? { "X-Request-ID": requestId } : {}),
        },
        body: data,
        signal: abort,
      });
    } catch (error) {
      if (abort?.aborted) return null;
      logger.warn("Fire Engine search request failed", { error });
      continue;
    }

    if (response.ok) return await response.json();
    await response.body?.cancel().catch(() => {});
    logger.warn("Fire Engine search returned non-OK response", {
      status: response.status,
    });
    if (response.status < 500) return null;
  }
  throw new SearchUnavailableError();
}
