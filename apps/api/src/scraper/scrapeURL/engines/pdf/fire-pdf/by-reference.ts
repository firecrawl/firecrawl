import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Meta } from "../../..";
import { config } from "../../../../../config";
import { storage } from "../../../../../lib/gcs-jobs";

/** Input handle for a FirePDF async submit that travels by GCS reference
 * instead of inline base64. Produced by {@link uploadPdfInputForFirePdf}. */
export type FirePdfByReferenceInput = {
  gcsUri: string;
  sha256: string;
  sizeBytes: number;
};

/** Uploading 256MB in-cluster to GCS is seconds; this bound exists so a
 * stuck stream cannot hold a scrape slot indefinitely. */
const UPLOAD_TIMEOUT_MS = 120_000;

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

/**
 * Stream a downloaded PDF from its temp file into the fire-pdf input bucket
 * so the async pipeline can fetch it by reference. Never buffers the file.
 *
 * Returns null on any failure (missing bucket grant, timeout, transport):
 * the caller falls back to the pre-by-reference behavior for oversized
 * files instead of failing the scrape on infra misconfiguration.
 */
export async function uploadPdfInputForFirePdf(
  meta: Meta,
  tempFilePath: string,
  sizeBytes: number,
): Promise<FirePdfByReferenceInput | null> {
  const bucketName = config.FIRE_PDF_GCS_INPUT_BUCKET;
  const objectKey = `inputs/${meta.id}.pdf`;
  const startedAt = Date.now();
  try {
    const sha256 = await sha256OfFile(tempFilePath);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `GCS input upload timed out after ${UPLOAD_TIMEOUT_MS}ms`,
            ),
          ),
        UPLOAD_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([
        storage.bucket(bucketName).upload(tempFilePath, {
          destination: objectKey,
          resumable: true,
          metadata: {
            contentType: "application/pdf",
            metadata: { scrape_id: meta.id, source: "firecrawl" },
          },
        }),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
    meta.logger.info("Uploaded large PDF for by-reference FirePDF submit", {
      method: "scrapePDF/firePdfByReference",
      event: "fire_pdf_by_reference_uploaded",
      scrape_id: meta.id,
      size_bytes: sizeBytes,
      duration_ms: Date.now() - startedAt,
      gcs_uri: `gs://${bucketName}/${objectKey}`,
    });
    return {
      gcsUri: `gs://${bucketName}/${objectKey}`,
      sha256,
      sizeBytes,
    };
  } catch (error) {
    meta.logger.warn(
      "Large-PDF GCS input upload failed; falling back to legacy handling",
      {
        method: "scrapePDF/firePdfByReference",
        event: "fire_pdf_by_reference_upload_failed",
        scrape_id: meta.id,
        team_id: meta.internalOptions.teamId,
        size_bytes: sizeBytes,
        bucket: bucketName,
        error,
      },
    );
    return null;
  }
}
