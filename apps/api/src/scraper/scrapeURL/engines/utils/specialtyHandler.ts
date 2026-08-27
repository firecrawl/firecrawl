import { Logger } from "winston";
import { AddFeatureError, UnsupportedFileError } from "../../error";
import { FireEngineCheckStatusSuccess } from "../fire-engine/checkStatus";
import path from "path";
import os from "os";
import { writeFile } from "fs/promises";
import { Meta } from "../..";
import { documentExtensionFromContentType } from "../../../../lib/document-formats";
import { downloadFireEngineGcsFile } from "./downloadGcsFile";

async function feResToFilePrefetch(
  logger: Logger,
  feRes: FireEngineCheckStatusSuccess | undefined,
  fileExtension: string,
  fileType: string,
  contentType?: string,
  signal?: AbortSignal,
  maxFileBytes?: number,
): Promise<Meta["pdfPrefetch"] | Meta["documentPrefetch"]> {
  const file = feRes?.file;
  if (!file || (file.content === undefined && file.gcs_uri === undefined)) {
    logger.warn(`No file in ${fileType} prefetch`);
    return null;
  }

  const filePath = path.join(
    os.tmpdir(),
    `tempFile-${crypto.randomUUID()}.${fileExtension}`,
  );

  let gcsReference: NonNullable<Meta["pdfPrefetch"]>["gcsReference"];
  if (file.content !== undefined) {
    await writeFile(filePath, Buffer.from(file.content, "base64"));
  } else {
    // Large-file handoff: fire-engine uploaded the bytes to GCS instead of
    // inlining hundreds of MB of base64 through its response and job store.
    // Materialize a local copy (magic-byte sniffing and page-count detection
    // need bytes on disk) and keep the reference so the FirePDF by-reference
    // path can server-side copy the object instead of re-uploading it.
    const downloaded = await downloadFireEngineGcsFile(
      logger,
      { uri: file.gcs_uri!, sha256: file.sha256, sizeBytes: file.size_bytes },
      filePath,
      signal,
      maxFileBytes,
    );
    if (downloaded === null) {
      return null;
    }
    gcsReference = {
      uri: file.gcs_uri!,
      sha256: file.sha256,
      sizeBytes: downloaded.sizeBytes,
      generation: downloaded.generation,
    };
  }

  return {
    status: feRes.pageStatusCode,
    url: feRes.url,
    filePath,
    proxyUsed: feRes.usedMobileProxy ? "stealth" : "basic",
    contentType,
    // References are only produced for PDFs; the document prefetch shape
    // does not carry one.
    ...(fileType === "pdf" && gcsReference ? { gcsReference } : {}),
  };
}

async function feResToPdfPrefetch(
  logger: Logger,
  feRes: FireEngineCheckStatusSuccess | undefined,
  signal?: AbortSignal,
  maxFileBytes?: number,
): Promise<Meta["pdfPrefetch"]> {
  return feResToFilePrefetch(
    logger,
    feRes,
    "pdf",
    "pdf",
    undefined,
    signal,
    maxFileBytes,
  );
}

async function feResToDocumentPrefetch(
  logger: Logger,
  feRes: FireEngineCheckStatusSuccess | undefined,
  contentType: string,
): Promise<Meta["documentPrefetch"]> {
  // Determine file extension from content type
  const extension =
    documentExtensionFromContentType(contentType)?.slice(1) ?? "tmp";

  return feResToFilePrefetch(logger, feRes, extension, "document", contentType);
}

export async function specialtyScrapeCheck(
  logger: Logger,
  headers: Record<string, string> | undefined,
  feRes?: FireEngineCheckStatusSuccess,
  /** Scrape abort signal — stops a large-PDF handoff download when the
   * request has been cancelled or timed out. */
  signal?: AbortSignal,
  /** Admission cap for handoff downloads — the historical download cap when
   * the FirePDF by-reference route is unreachable for this request, so an
   * unusable large handoff never consumes network and temp disk. */
  maxFileBytes?: number,
) {
  const contentType = (Object.entries(headers ?? {}).find(
    x => x[0].toLowerCase() === "content-type",
  ) ?? [])[1];

  // A GCS reference is a PDF signal on its own — fire-engine only hands
  // off verified PDFs — so it is handled before the content-type guard:
  // some responses omit the header entirely, and the reference must still
  // reach the FirePDF path.
  if (feRes?.file?.gcs_uri !== undefined) {
    throw new AddFeatureError(
      ["pdf"],
      await feResToPdfPrefetch(logger, feRes, signal, maxFileBytes),
    );
  }

  if (!contentType) {
    logger.warn("Failed to check contentType -- was not present in headers", {
      headers,
    });
    return;
  }

  const isDocument = documentExtensionFromContentType(contentType) !== null;
  const isPdf =
    contentType === "application/pdf" ||
    contentType.startsWith("application/pdf;");
  const isOctetStream = contentType === "application/octet-stream";

  // Check for document types first (before PDF to prioritize documents)
  if (isDocument) {
    throw new AddFeatureError(
      ["document"],
      undefined,
      await feResToDocumentPrefetch(logger, feRes, contentType),
    );
  }

  // Check for octet-stream with document signature
  // Modern Office files (.docx, .xlsx) are ZIP archives starting with "PK" (base64: "UEsD")
  // Legacy Office files (.doc, .xls) are OLE2/CFB files starting with D0 CF 11 E0 (base64: "0M8R4K")
  if (isOctetStream) {
    const isZipSignature =
      feRes?.file?.content?.startsWith("UEsD") ||
      feRes?.content.startsWith("PK");
    const isOleSignature =
      feRes?.file?.content?.startsWith("0M8R4K") ||
      feRes?.content.startsWith("\xD0\xCF\x11\xE0");

    if (isZipSignature) {
      throw new AddFeatureError(
        ["document"],
        undefined,
        await feResToDocumentPrefetch(logger, feRes, contentType),
      );
    }
    if (isOleSignature) {
      // OLE2 signature is shared by .doc/.xls/.ppt files
      // Only override to application/msword if URL suggests it's a .doc file
      const url = feRes?.url?.toLowerCase() ?? "";
      const isDocUrl = url.endsWith(".doc") || url.includes(".doc?");
      const effectiveContentType = isDocUrl
        ? "application/msword"
        : contentType;
      throw new AddFeatureError(
        ["document"],
        undefined,
        await feResToDocumentPrefetch(logger, feRes, effectiveContentType),
      );
    }
  }

  // Check for PDF (references were already handled above the header guard).
  if (isPdf) {
    throw new AddFeatureError(
      ["pdf"],
      await feResToPdfPrefetch(logger, feRes, signal, maxFileBytes),
    );
  }

  // Check for octet-stream with PDF signature
  if (
    isOctetStream &&
    (feRes?.file?.content?.startsWith("JVBERi0") ||
      feRes?.content.startsWith("%PDF-"))
  ) {
    throw new AddFeatureError(
      ["pdf"],
      await feResToPdfPrefetch(logger, feRes, signal, maxFileBytes),
    );
  }

  // Reject unsupported binary content types (images, video, audio, archives, etc.)
  const unsupportedBinaryPrefixes = [
    "image/",
    "video/",
    "audio/",
    "application/zip",
    "application/x-tar",
    "application/x-rar",
    "application/x-7z",
    "application/wasm",
    "application/x-executable",
    "application/x-sharedlib",
    "application/java-archive",
  ];
  if (
    unsupportedBinaryPrefixes.some(prefix => contentType.startsWith(prefix))
  ) {
    throw new UnsupportedFileError(contentType);
  }
}
