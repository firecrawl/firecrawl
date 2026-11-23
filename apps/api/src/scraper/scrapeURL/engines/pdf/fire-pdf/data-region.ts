import type { Meta } from "../../..";
import {
  ReservedCapacityUnavailableError,
  UsOnlyUnavailableError,
} from "../../../error";
import type { FirePdfSourceKind } from "./request-metadata";

/**
 * Whether a pinned PDF service failure says the GPU acquires it needed in the
 * region were refused: `data_region_refusals` on a sync error body, or the
 * refusal note a failed job appends to its `error_message`. Only call it on a
 * failure: a job that finished in the region can still report refused acquires.
 */
export function firePdfRegionRefused(body: unknown): boolean {
  return firePdfRestrictionRefused(
    body,
    "data_region_refusals",
    /\[data_region=\w+ refused: /,
  );
}

function firePdfRestrictionRefused(
  body: unknown,
  refusalsField: string,
  notePattern: RegExp,
): boolean {
  let parsed = body;
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body);
    } catch {
      return false;
    }
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const fields = parsed as Record<string, unknown>;
  const refusals = fields[refusalsField];
  if (
    typeof refusals === "object" &&
    refusals !== null &&
    !Array.isArray(refusals) &&
    Object.keys(refusals).length > 0
  )
    return true;
  const errorMessage = fields.error_message;
  return typeof errorMessage === "string" && notePattern.test(errorMessage);
}

/**
 * Whether a PDF service failure restricted to reserved capacity says the
 * capacity it needed there was refused: `reserved_refusals` on a sync error
 * body, or the refusal note a failed job appends to its `error_message`.
 * Only call it on a failure.
 */
export function firePdfReservedRefused(body: unknown): boolean {
  return firePdfRestrictionRefused(
    body,
    "reserved_refusals",
    /\[reserved refused: /,
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

/** The error a team restricted to reserved capacity gets when the PDF service did not run, or did not confirm running, its document there. */
export function firePdfReservedCapacityRefusal(
  meta: Meta,
  reason: "reserved_unavailable" | "reserved_unconfirmed",
  sourceKind: FirePdfSourceKind = "pdf",
): ReservedCapacityUnavailableError {
  meta.logger.warn("FirePDF could not keep a request on reserved capacity", {
    scrapeId: meta.id,
    reason,
    sourceKind,
  });
  return new ReservedCapacityUnavailableError();
}
