import type { Meta } from "../../..";
import { UsOnlyUnavailableError } from "../../../error";
import type { FirePdfSourceKind } from "./request-metadata";

/**
 * Whether a pinned PDF service failure says the GPU acquires it needed in the
 * region were refused: `data_region_refusals` on a sync error body, or the
 * refusal note a failed job appends to its `error_message`. Only call it on a
 * failure: a job that finished in the region can still report refused acquires.
 */
export function firePdfRegionRefused(body: unknown): boolean {
  let parsed = body;
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body);
    } catch {
      return false;
    }
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const { data_region_refusals, error_message } = parsed as Record<
    string,
    unknown
  >;
  if (
    typeof data_region_refusals === "object" &&
    data_region_refusals !== null &&
    !Array.isArray(data_region_refusals) &&
    Object.keys(data_region_refusals).length > 0
  )
    return true;
  return (
    typeof error_message === "string" &&
    /\[data_region=\w+ refused: /.test(error_message)
  );
}

/** The error a US-only team gets when the PDF service did not run, or did not confirm running, its document on US capacity. */
export function firePdfUsOnlyRefusal(
  meta: Meta,
  reason: "region_unavailable" | "region_unconfirmed",
  sourceKind: FirePdfSourceKind = "pdf",
): UsOnlyUnavailableError {
  meta.logger.warn("FirePDF could not keep a US-only request on US capacity", {
    scrapeId: meta.id,
    reason,
    sourceKind,
  });
  const feature = sourceKind === "image" ? "Image OCR" : "PDF parsing";
  const detail =
    reason === "region_unconfirmed"
      ? "the PDF service did not confirm US-only processing"
      : "no US capacity could take this document";
  return new UsOnlyUnavailableError(
    `${feature} is not available for teams restricted to US-only processing right now: ${detail}. Try again later.`,
  );
}
