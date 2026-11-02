import type { Meta } from "../../..";
import { UsOnlyUnavailableError } from "../../../error";
import type { FirePdfSourceKind } from "./request-metadata";

/** The `data_region` value that pins a US-only team's GPU work to US capacity. */
export const US_DATA_REGION = "us";

/**
 * Whether a PDF service reply refuses a pinned request because no in-region
 * GPU capacity could take it. Accepts a parsed body or raw JSON text.
 */
export function isRegionUnavailable(body: unknown): boolean {
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
  return ["code", "error_code", "error_class", "error"].some(
    key => fields[key] === "region_unavailable",
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
  return new UsOnlyUnavailableError(
    `${feature} is not available for teams restricted to US-only processing right now: no US capacity could take this document. Try again later.`,
  );
}
