import { Logger } from "winston";
import { AddFeatureError, UnsupportedFileError } from "../../error";
import path from "path";
import os from "os";
import { writeFile } from "fs/promises";
import { Meta } from "../..";
import { documentExtensionFromContentType } from "../../../../lib/document-formats";

export interface GcsFileDownloader {
  /** Explicitly configured GCS handoff bucket; unset values reject all URIs. */
  readonly allowedBucket: string | undefined;
  download: (
    logger: Logger,
    file: { uri: string; sha256?: string; sizeBytes?: number },
    destPath: string,
    signal?: AbortSignal,
    maxBytes?: number,
  ) => Promise<{ sizeBytes: number; generation?: string } | null>;
}

function declaredContentLength(
  headers: Record<string, string> | undefined,
): number | undefined {
  if (!headers) return undefined;
  const header = (name: string) =>
    Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1];
  const encoding = header("content-encoding")?.trim().toLowerCase();
  if (encoding && encoding !== "identity") return undefined;
  const raw = header("content-length")?.trim();
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const length = Number(raw);
  return Number.isSafeInteger(length) && length > 0 ? length : undefined;
}
import {
  imageExtensionFromContentType,
  sniffImageContentTypeFromBase64,
} from "../../../../lib/image-formats";
import type { ImageOcrGate } from "../../../../lib/image-ocr-gate";
import { installedService } from "../../../../service/service";

export function hasFilePrefetchEngine(): boolean {
  return (
    installedService()
      ?.engines.all()
      .some(engine => engine.prefetchesFiles === true && engine.enabled()) ??
    false
  );
}

export interface SpecialtyHandoffResponse {
  url?: string;
  content: string;
  pageStatusCode: number;
  usedMobileProxy?: boolean;
  responseHeaders?: Record<string, string>;
  file?: {
    content?: string;
    gcs_uri?: string;
    sha256?: string;
    size_bytes?: number;
  } | null;
}

async function feResToFilePrefetch(
  logger: Logger,
  feRes: SpecialtyHandoffResponse | undefined,
  fileExtension: string,
  fileType: string,
  contentType?: string,
  signal?: AbortSignal,
  maxFileBytes?: number,
  downloadGcsFile?: GcsFileDownloader,
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
  let handoff: NonNullable<Meta["pdfPrefetch"]>["handoff"];
  if (file.content !== undefined) {
    await writeFile(filePath, Buffer.from(file.content, "base64"));
    handoff = {
      contentLength: declaredContentLength(feRes.responseHeaders),
    };
  } else {
    // Large-file handoff: fire-engine uploaded the bytes to GCS instead of
    // inlining hundreds of MB of base64 through its response and job store.
    // Materialize a local copy (magic-byte sniffing and page-count detection
    // need bytes on disk) and keep the reference so the FirePDF by-reference
    // path can server-side copy the object instead of re-uploading it.
    if (signal?.aborted) {
      throw signal.reason;
    }
    if (!downloadGcsFile) {
      logger.warn(
        "GCS file handoff requested without a configured downloader",
        {
          uri: file.gcs_uri,
        },
      );
      return null;
    }
    const allowedBucket = downloadGcsFile.allowedBucket?.trim();
    const parsedGcsUri = file.gcs_uri
      ? /^gs:\/\/([^/]+)\/(.+)$/.exec(file.gcs_uri)
      : null;
    if (!allowedBucket || !parsedGcsUri || parsedGcsUri[1] !== allowedBucket) {
      logger.warn("GCS file handoff rejected by bucket allowlist", {
        uri: file.gcs_uri,
        allowedBucketConfigured: Boolean(allowedBucket),
      });
      return null;
    }
    const downloaded = await downloadGcsFile.download(
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
    ...(fileType === "pdf" && handoff ? { handoff } : {}),
  };
}

async function feResToPdfPrefetch(
  logger: Logger,
  feRes: SpecialtyHandoffResponse | undefined,
  signal?: AbortSignal,
  maxFileBytes?: number,
  downloadGcsFile?: GcsFileDownloader,
): Promise<Meta["pdfPrefetch"]> {
  return feResToFilePrefetch(
    logger,
    feRes,
    "pdf",
    "pdf",
    undefined,
    signal,
    maxFileBytes,
    downloadGcsFile,
  );
}

async function feResToDocumentPrefetch(
  logger: Logger,
  feRes: SpecialtyHandoffResponse | undefined,
  contentType: string | undefined,
  downloadGcsFile?: GcsFileDownloader,
): Promise<Meta["documentPrefetch"]> {
  // Determine file extension from content type
  const extension =
    documentExtensionFromContentType(contentType)?.slice(1) ?? "tmp";

  return feResToFilePrefetch(
    logger,
    feRes,
    extension,
    "document",
    contentType,
    undefined,
    undefined,
    downloadGcsFile,
  );
}

async function feResToImagePrefetch(
  logger: Logger,
  feRes: SpecialtyHandoffResponse | undefined,
  contentType: string,
  downloadGcsFile?: GcsFileDownloader,
): Promise<Meta["imagePrefetch"]> {
  const extension =
    imageExtensionFromContentType(contentType)?.slice(1) ?? "img";

  return feResToFilePrefetch(
    logger,
    feRes,
    extension,
    "image",
    contentType,
    undefined,
    undefined,
    downloadGcsFile,
  );
}

/**
 * Sniffs a browser handoff for a raster image the image engine can OCR.
 * Returns the canonical content type from the magic bytes, or null when the
 * payload is missing, is not a supported format, or the request may not OCR
 * images (no image parser, or the switch is off) — in which case the
 * caller falls through to the historical unsupported-file rejection.
 */
async function sniffImageHandoff(
  feRes: SpecialtyHandoffResponse | undefined,
  imageOcrEnabled: ImageOcrGate,
): Promise<string | null> {
  const content = feRes?.file?.content;
  if (content === undefined) return null;
  const contentType = sniffImageContentTypeFromBase64(content);
  if (contentType === null) return null;
  // Only now consult the gate (image parser + deployment switch); non-image
  // responses never reach it.
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
  feRes: SpecialtyHandoffResponse | undefined,
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
  feRes: SpecialtyHandoffResponse | undefined,
  contentType: string | undefined,
  signal?: AbortSignal,
  maxFileBytes?: number,
  downloadGcsFile?: GcsFileDownloader,
): Promise<never> {
  if (kind === "pdf") {
    throw new AddFeatureError(
      ["pdf"],
      await feResToPdfPrefetch(
        logger,
        feRes,
        signal,
        maxFileBytes,
        downloadGcsFile,
      ),
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
    await feResToDocumentPrefetch(
      logger,
      feRes,
      effectiveContentType,
      downloadGcsFile,
    ),
  );
}

export async function specialtyScrapeCheck(
  logger: Logger,
  headers: Record<string, string> | undefined,
  feRes?: SpecialtyHandoffResponse,
  signal?: AbortSignal,
  maxFileBytes?: number,
  imageOcrEnabled: ImageOcrGate = async () => false,
  downloadGcsFile?: GcsFileDownloader,
) {
  const contentType = (Object.entries(headers ?? {}).find(
    x => x[0].toLowerCase() === "content-type",
  ) ?? [])[1];

  if (feRes?.file?.gcs_uri !== undefined) {
    throw new AddFeatureError(
      ["pdf"],
      await feResToPdfPrefetch(
        logger,
        feRes,
        signal,
        maxFileBytes,
        downloadGcsFile,
      ),
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
        await feResToImagePrefetch(
          logger,
          feRes,
          headerlessImage,
          downloadGcsFile,
        ),
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
        downloadGcsFile,
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
      await feResToDocumentPrefetch(
        logger,
        feRes,
        contentType,
        downloadGcsFile,
      ),
    );
  }

  // Check for PDF (references were already handled above the header guard).
  if (isPdf) {
    throw new AddFeatureError(
      ["pdf"],
      await feResToPdfPrefetch(
        logger,
        feRes,
        signal,
        maxFileBytes,
        downloadGcsFile,
      ),
    );
  }

  const mediaType = contentType.split(";")[0].trim().toLowerCase();

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
        await feResToImagePrefetch(logger, feRes, imageType, downloadGcsFile),
      );
    }
  }

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
      downloadGcsFile,
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
