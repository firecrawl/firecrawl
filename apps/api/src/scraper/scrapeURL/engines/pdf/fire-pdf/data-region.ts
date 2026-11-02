import type { Meta } from "../../..";
import { UsOnlyUnavailableError } from "../../../error";
import type { FirePdfSourceKind } from "./request-metadata";

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
