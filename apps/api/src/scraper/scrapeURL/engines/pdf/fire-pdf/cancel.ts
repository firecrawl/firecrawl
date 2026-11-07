import type { Meta } from "../../..";
import { fetch as undiciFetch } from "undici";
import { firePdfHeaders } from "./utils";

type CancelJobArgs = {
  baseUrl: string;
  scrapeId: string;
  meta: Meta;
  fetchImpl: typeof undiciFetch;
};

const CANCEL_TIMEOUT_MS = 2_000;

/** Best-effort cleanup after Firecrawl abandons an accepted async job. */
export async function cancelJob(args: CancelJobArgs): Promise<void> {
  const { baseUrl, scrapeId, meta, fetchImpl } = args;
  try {
    const response = await fetchImpl(`${baseUrl}/jobs/${scrapeId}`, {
      method: "DELETE",
      headers: firePdfHeaders(),
      // Do not reuse the caller's signal: it is often already aborted.
      signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS),
    });
    await response.body?.cancel();
    if (response.status !== 200 && response.status !== 404) {
      meta.logger.warn("FirePDF async cancellation was not accepted", {
        scrapeId,
        status: response.status,
      });
    }
  } catch (error) {
    meta.logger.warn("FirePDF async cancellation failed", {
      scrapeId,
      error: String(error),
    });
  }
}
