import { Logger } from "winston";
import { AddFeatureError, UnsupportedFileError } from "../../error";
import { FireEngineCheckStatusSuccess } from "../fire-engine/checkStatus";
import path from "path";
import os from "os";
import { writeFile } from "fs/promises";
import { Meta } from "../..";
import { documentExtensionFromContentType } from "../../../../lib/document-formats";
import { downloadFireEngineGcsFile } from "./downloadGcsFile";
import {
  imageExtensionFromContentType,
  sniffImageContentTypeFromBase64,
} from "../../../../lib/image-formats";
import type { ImageOcrGate } from "../../../../lib/image-ocr-gate";

async function feResToFilePrefetch(
  logger: Logger,
  feRes: FireEngineCheckStatusSuccess | undefined,
  fileExtension: string,
  fileType: string,
  contentType?: string,
  signal?: AbortSignal,
  maxFileBytes?: number,
): Promise<
  Meta["pdfPrefetch"] | Meta["documentPrefetch"] | Meta["imagePrefetch"]
> {
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
  contentType: string | undefined,
): Promise<Meta["documentPrefetch"]> {
  // Determine file extension from content type
  const extension =
    documentExtensionFromContentType(contentType)?.slice(1) ?? "tmp";

  return feResToFilePrefetch(logger, feRes, extension, "document", contentType);
}

async function feResToImagePrefetch(
  logger: Logger,
  feRes: FireEngineCheckStatusSuccess | undefined,
  contentType: string,
): Promise<Meta["imagePrefetch"]> {
  const extension =
    imageExtensionFromContentType(contentType)?.slice(1) ?? "img";

  return feResToFilePrefetch(logger, feRes, extension, "image", contentType);
}

/**
 * Sniffs a browser handoff for a raster image the image engine can OCR.
 * Returns the canonical content type from the magic bytes, or null when the
 * payload is missing, is not a supported format, or the request may not OCR
 * images (no image parser, or a team without the flag) — in which case the
 * caller falls through to the historical unsupported-file rejection.
 */
async function sniffImageHandoff(
  feRes: FireEngineCheckStatusSuccess | undefined,
  imageOcrEnabled: ImageOcrGate,
): Promise<string | null> {
  const content = feRes?.file?.content;
  if (content === undefined) return null;
  const contentType = sniffImageContentTypeFromBase64(content);
  if (contentType === null) return null;
  // Only now consult the gate (image parser + team flag): this is the one
  // lookup an image request may cost, and non-image responses never reach it.
  return (await imageOcrEnabled()) ? contentType : null;
}

/**
 * File types the parser engines can open, recognized from magic bytes.
 * Servers mislabel freely — a PDF behind a generic download endpoint comes
 * back as application/octet-stream or image/jp2, an Office file as
 * application/x-download — and a browser can only hand off what it could not
 * render, so once the header has failed to name a parseable type the bytes
 * decide which engine gets the file.
 */
type HandoffFileKind = "pdf" | "zip" | "ole";

const HANDOFF_FILE_SIGNATURES: Array<{
  kind: HandoffFileKind;
  bytes: number[];
}> = [
  // "%PDF-"
  { kind: "pdf", bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  // "PK\x03\x04": the local file header every OOXML/ODF container (.docx,
  // .xlsx, .pptx, .odt, ...) starts with. All four bytes, so a text body that
  // merely begins with "PK" is not mistaken for an archive.
  { kind: "zip", bytes: [0x50, 0x4b, 0x03, 0x04] },
  // OLE2/CFB header shared by legacy Office files (.doc, .xls, .ppt).
  { kind: "ole", bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
];

const HANDOFF_SNIFF_BYTES = Math.max(
  ...HANDOFF_FILE_SIGNATURES.map(s => s.bytes.length),
);

// Headers that already declare a ZIP archive. A ZIP signature under one of
// these confirms a real archive rather than exposing a mislabeled Office
// file, so it keeps the unsupported-file rejection instead of being sent to
// the document parser.
const ZIP_ARCHIVE_MEDIA_TYPES = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/java-archive",
]);

function matchHandoffSignature(
  head: ArrayLike<number>,
): HandoffFileKind | null {
  for (const { kind, bytes } of HANDOFF_FILE_SIGNATURES) {
    if (head.length < bytes.length) continue;
    let matches = true;
    for (let i = 0; i < bytes.length; i++) {
      if (head[i] !== bytes[i]) {
        matches = false;
        break;
      }
    }
    if (matches) return kind;
  }
  return null;
}

/**
 * Identifies a handoff's file type from its leading bytes. A captured
 * download arrives base64-encoded in `file.content` (4 characters encode 3
 * bytes, so a short prefix covers the longest signature without decoding the
 * file); a body fire-engine returned as text sits in `content` and is
 * compared character by character.
 */
function sniffHandoffFileKind(
  feRes: FireEngineCheckStatusSuccess | undefined,
): HandoffFileKind | null {
  if (!feRes) return null;
  if (feRes.file?.content !== undefined) {
    const chars = Math.ceil(HANDOFF_SNIFF_BYTES / 3) * 4;
    const kind = matchHandoffSignature(
      Buffer.from(feRes.file.content.slice(0, chars), "base64"),
    );
    if (kind !== null) return kind;
  }
  return matchHandoffSignature(
    Array.from(feRes.content.slice(0, HANDOFF_SNIFF_BYTES), c =>
      c.charCodeAt(0),
    ),
  );
}

/**
 * Hands a sniffed file to the engine that parses it. `contentType` is the
 * header as served (undefined without one); the document engine only uses it
 * as an extension hint before falling back to the URL path and the
 * converter's own detection.
 */
async function handoffSniffedFile(
  kind: HandoffFileKind,
  logger: Logger,
  feRes: FireEngineCheckStatusSuccess | undefined,
  contentType: string | undefined,
  signal?: AbortSignal,
  maxFileBytes?: number,
): Promise<never> {
  if (kind === "pdf") {
    throw new AddFeatureError(
      ["pdf"],
      await feResToPdfPrefetch(logger, feRes, signal, maxFileBytes),
    );
  }
  // OLE2 signature is shared by .doc/.xls/.ppt files
  // Only override to application/msword if URL suggests it's a .doc file
  const url = feRes?.url?.toLowerCase() ?? "";
  const isDocUrl = url.endsWith(".doc") || url.includes(".doc?");
  const effectiveContentType =
    kind === "ole" && isDocUrl ? "application/msword" : contentType;
  throw new AddFeatureError(
    ["document"],
    undefined,
    await feResToDocumentPrefetch(logger, feRes, effectiveContentType),
  );
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
  /** Per-request image OCR gate (image parser + team flag; lazy, memoized),
   * consulted only once the bytes sniff as a supported image; off means
   * images keep the unsupported-file rejection below. */
  imageOcrEnabled: ImageOcrGate = async () => false,
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
    // A header-less binary is still recognizable by its magic bytes.
    const headerlessImage = await sniffImageHandoff(feRes, imageOcrEnabled);
    if (headerlessImage !== null) {
      throw new AddFeatureError(
        ["image"],
        undefined,
        undefined,
        await feResToImagePrefetch(logger, feRes, headerlessImage),
      );
    }
    const headerlessFile = sniffHandoffFileKind(feRes);
    if (headerlessFile !== null) {
      await handoffSniffedFile(
        headerlessFile,
        logger,
        feRes,
        undefined,
        signal,
        maxFileBytes,
      );
    }
    logger.warn("Failed to check contentType -- was not present in headers", {
      headers,
    });
    return;
  }

  const isDocument = documentExtensionFromContentType(contentType) !== null;
  const isPdf =
    contentType === "application/pdf" ||
    contentType.startsWith("application/pdf;");

  // Check for document types first (before PDF to prioritize documents)
  if (isDocument) {
    throw new AddFeatureError(
      ["document"],
      undefined,
      await feResToDocumentPrefetch(logger, feRes, contentType),
    );
  }

  // Check for PDF (references were already handled above the header guard).
  if (isPdf) {
    throw new AddFeatureError(
      ["pdf"],
      await feResToPdfPrefetch(logger, feRes, signal, maxFileBytes),
    );
  }

  const mediaType = contentType.split(";")[0].trim().toLowerCase();

  // Raster images are OCR'd as one-page scanned documents by the image
  // engine (see engines/image). The header must claim an image or an opaque
  // octet-stream AND the bytes must confirm a format FirePDF can open, so a
  // mislabeled HTML error page served as image/jpeg is never sent to OCR
  // and WebP/SVG/AVIF keep failing fast below.
  if (
    mediaType.startsWith("image/") ||
    mediaType === "application/octet-stream"
  ) {
    const imageType = await sniffImageHandoff(feRes, imageOcrEnabled);
    if (imageType !== null) {
      throw new AddFeatureError(
        ["image"],
        undefined,
        undefined,
        await feResToImagePrefetch(logger, feRes, imageType),
      );
    }
  }

  // The header named no parseable type, but the bytes may still: a PDF served
  // as application/octet-stream or image/jp2, an Office file behind a generic
  // download endpoint. The browser only hands off what it could not render,
  // so every remaining content type is sniffed — after the image check above,
  // so a real raster image still reaches OCR, and before the rejection below,
  // so a mislabeled PDF is parsed instead of failing as an unsupported image.
  const sniffedFile = sniffHandoffFileKind(feRes);
  if (
    sniffedFile !== null &&
    !(sniffedFile === "zip" && ZIP_ARCHIVE_MEDIA_TYPES.has(mediaType))
  ) {
    await handoffSniffedFile(
      sniffedFile,
      logger,
      feRes,
      contentType,
      signal,
      maxFileBytes,
    );
  }

  // Reject unsupported binary content types (unsupported images, video, audio, archives, etc.)
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
