/**
 * FirePDF content-level job lookup (POST /jobs/lookup) — the adoption
 * half of the async job protocol. Lives alongside submit/poll/result
 * rather than the GCS transport helpers: adoption is about which JOB an
 * attempt watches, not how bytes travel.
 */
import type { Meta } from "../../..";
import { config } from "../../../../../config";
import { fetch as undiciFetch } from "undici";
import { firePdfHeaders } from "./utils";

/** Handle for adopting an existing fire-pdf job instead of submitting a
 * new one. Produced by {@link lookupAdoptableFirePdfJob}: the job was
 * created by an earlier attempt (ours or another pod's) for the same
 * document bytes and options, so the async flow polls it rather than
 * re-uploading and re-processing. `sha256` keeps the raw-byte cache
 * identity so the adopted result still lands in the content cache. */
export type FirePdfAdoptedJobInput = {
  adoptScrapeId: string;
  sha256: string;
};

/** The lookup is one indexed Postgres read behind fire-pdf's API; this
 * bound keeps a hung fire-pdf from eating the scrape budget on what is a
 * pure optimization. */
const LOOKUP_TIMEOUT_MS = 10_000;

/**
 * Ask fire-pdf whether a job already exists for these exact document
 * bytes and options (POST /jobs/lookup). Retries arrive with fresh
 * scrape_ids, so fire-pdf's scrape_id-keyed idempotency cannot join
 * them to the original job — this content-level lookup can. A hit means
 * the caller skips the 30-256MB upload AND the duplicate processing run,
 * and just polls the returned scrape_id.
 *
 * Scoped to the submitting team: the body's team_id mirrors what the
 * submit sends (absent when the account context has none), and fire-pdf
 * only matches jobs with the same value — a request can never adopt
 * another tenant's job.
 *
 * Best-effort by design: any failure (endpoint missing on an older
 * fire-pdf, timeout, malformed body) returns null and the caller submits
 * fresh — adoption can only ever remove work, never add failure modes.
 * Scrape aborts are the one exception and propagate.
 */
export async function lookupAdoptableFirePdfJob(
  meta: Meta,
  sha256: string,
  options: Record<string, unknown>,
  fetchImpl: typeof undiciFetch = undiciFetch,
): Promise<FirePdfAdoptedJobInput | null> {
  const baseUrl = config.FIRE_PDF_BASE_URL;
  if (!baseUrl) return null;
  try {
    // A first asSignal() call AFTER cancellation returns a signal whose
    // abort listeners were attached post-abort and never fire — check the
    // manager directly first.
    meta.abort.throwIfAborted();
    const signal = AbortSignal.any([
      AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      meta.abort.asSignal(),
    ]);
    const resp = await fetchImpl(`${baseUrl}/jobs/lookup`, {
      method: "POST",
      headers: firePdfHeaders(true),
      body: JSON.stringify({
        input_sha256: sha256,
        // Same conditional shape as the submit body — the lookup must
        // mirror it exactly for `IS NOT DISTINCT FROM` to match.
        ...(meta.internalOptions.teamId && {
          team_id: meta.internalOptions.teamId,
        }),
        options,
      }),
      signal,
    });
    if (resp.status === 404) return null;
    if (resp.status !== 200) {
      meta.logger.warn(
        "FirePDF adoption lookup returned non-200; submitting fresh",
        {
          method: "scrapePDF/firePdfByReference",
          event: "fire_pdf_adoption_lookup_miss",
          status: resp.status,
          scrape_id: meta.id,
        },
      );
      return null;
    }
    const json = (await resp.json()) as {
      scrape_id?: unknown;
      status?: unknown;
    };
    if (typeof json.scrape_id !== "string" || json.scrape_id.length === 0) {
      return null;
    }
    meta.logger.info("FirePDF adoption lookup hit", {
      method: "scrapePDF/firePdfByReference",
      event: "fire_pdf_adoption_lookup_hit",
      scrape_id: meta.id,
      adopted_scrape_id: json.scrape_id,
      adopted_status: json.status,
    });
    return { adoptScrapeId: json.scrape_id, sha256 };
  } catch (error) {
    // An aborted scrape must not proceed to a fresh upload+submit.
    meta.abort.throwIfAborted();
    meta.logger.warn("FirePDF adoption lookup failed; submitting fresh", {
      method: "scrapePDF/firePdfByReference",
      event: "fire_pdf_adoption_lookup_failed",
      error,
      scrape_id: meta.id,
    });
    return null;
  }
}
