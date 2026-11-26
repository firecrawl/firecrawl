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
  "application/vnd.android.package-archive",
  "application/x-xpinstall",
  "application/x-chrome-extension",
]);

const ZIP_ARCHIVE_EXTENSIONS = new Set([
  ".zip",
  ".apk",
  ".aab",
  ".ipa",
  ".jar",
  ".war",
  ".whl",
  ".xpi",
  ".crx",
  ".nupkg",
]);

const OLE_INSTALLER_MEDIA_TYPES = new Set([
  "application/x-msi",
  "application/vnd.ms-msi",
  "application/x-ole-storage",
  "application/x-msdownload",
  "application/x-msdos-program",
  "application/x-dosexec",
  "application/vnd.microsoft.portable-executable",
]);

const OLE_INSTALLER_EXTENSIONS = new Set([".msi", ".msp", ".mst"]);

const BINARY_ATTACHMENT_EXTENSIONS = new Set([
  ...ZIP_ARCHIVE_EXTENSIONS,
  ...OLE_INSTALLER_EXTENSIONS,
  ".exe",
  ".msix",
  ".dmg",
  ".pkg",
  ".mpkg",
  ".iso",
  ".img",
  ".bin",
  ".run",
  ".appimage",
  ".deb",
  ".rpm",
  ".tar",
  ".tgz",
  ".tbz2",
  ".txz",
  ".gz",
  ".bz2",
  ".xz",
  ".zst",
  ".7z",
  ".rar",
  ".wasm",
  ".so",
  ".dll",
  ".dylib",
]);

const GZIP_MEDIA_TYPES = new Set(["application/gzip", "application/x-gzip"]);

const GENERIC_OCTET_MEDIA_TYPES = new Set([
  "application/octet-stream",
  "binary/octet-stream",
  "application/x-download",
  "application/force-download",
  "application/download",
]);

const utf8FatalDecoder = new TextDecoder("utf-8", { fatal: true });

function isGzippedFileHandoff(
  feRes: SpecialtyHandoffResponse | undefined,
): boolean {
  if (feRes?.file?.content === undefined) return false;
  const head = Buffer.from(feRes.file.content.slice(0, 4), "base64");
  return head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b;
}

function hasBinaryOrGzipArchiveUrlExtension(
  urlString: string | undefined,
): boolean {
  if (!urlString) return false;
  try {
    const lowerPath = new URL(urlString).pathname.toLowerCase();
    if (lowerPath.endsWith(".tgz")) return true;
    if (lowerPath.endsWith(".gz")) {
      const stem = lowerPath.slice(0, -3);
      return BINARY_ATTACHMENT_EXTENSIONS.has(path.extname(stem));
    }
    return BINARY_ATTACHMENT_EXTENSIONS.has(path.extname(lowerPath));
  } catch {
    return false;
  }
}

function hasXmlGzipUrlExtension(urlString: string | undefined): boolean {
  if (!urlString) return false;
  try {
    return new URL(urlString).pathname.toLowerCase().endsWith(".xml.gz");
  } catch {
    return false;
  }
}

function isAllowedGzipFileHandoff(
  feRes: SpecialtyHandoffResponse | undefined,
  mediaType: string | undefined,
  attachmentBinaryExt: string | null,
): boolean {
  if (!isGzippedFileHandoff(feRes)) return false;
  if (attachmentBinaryExt !== null) return false;
  if (hasBinaryOrGzipArchiveUrlExtension(feRes?.url)) return false;
  if (mediaType === undefined) {
    return hasXmlGzipUrlExtension(feRes?.url);
  }
  return (
    GZIP_MEDIA_TYPES.has(mediaType) ||
    (mediaType === "application/octet-stream" &&
      hasXmlGzipUrlExtension(feRes?.url))
  );
}

function hasNullBytesWithoutUtf16Bom(
  feRes: SpecialtyHandoffResponse | undefined,
): boolean {
  if (!feRes) return false;
  const bytes =
    feRes.file?.content !== undefined
      ? Buffer.from(feRes.file.content.slice(0, 684), "base64")
      : Buffer.from(feRes.content.slice(0, 512), "latin1");
  if (bytes.length === 0) return false;
  if (
    bytes.length >= 2 &&
    ((bytes[0] === 0xff && bytes[1] === 0xfe) ||
      (bytes[0] === 0xfe && bytes[1] === 0xff))
  ) {
    return false;
  }
  return bytes.includes(0x00);
}

function binaryAttachmentExtension(
  headers: Record<string, string> | undefined,
): string | null {
  const disposition = Object.entries(headers ?? {}).find(
    ([k]) => k.toLowerCase() === "content-disposition",
  )?.[1];
  if (!disposition || !/^\s*attachment\b/i.test(disposition)) return null;
  const utf8Match = /filename\*\s*=\s*(?:utf-8|iso-8859-1)?''([^;\s]+)/i.exec(
    disposition,
  );
  const plainMatch = /filename\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(
    disposition,
  );
  let rawName = utf8Match?.[1] ?? plainMatch?.[1] ?? plainMatch?.[2];
  if (!rawName) return null;
  try {
    rawName = decodeURIComponent(rawName);
  } catch {}
  const ext = path.extname(rawName).toLowerCase();
  return BINARY_ATTACHMENT_EXTENSIONS.has(ext) ? ext : null;
}

function hasDisallowedBinaryControlByte(bytes: Buffer): boolean {
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (
      (b >= 0x00 && b <= 0x08) ||
      b === 0x0b ||
      (b >= 0x0e && b <= 0x1f) ||
      b === 0x7f
    ) {
      return true;
    }
  }
  return false;
}

function trimIncompleteTrailingUtf8(bytes: Buffer): Buffer {
  if (bytes.length < 4) return bytes;
  let idx = bytes.length - 1;
  let continuations = 0;
  while (idx >= 0 && continuations < 3 && (bytes[idx] & 0xc0) === 0x80) {
    idx--;
    continuations++;
  }
  if (idx < 0) return bytes;
  const lead = bytes[idx];
  const expectedLen =
    lead >= 0xc2 && lead <= 0xdf
      ? 2
      : lead >= 0xe0 && lead <= 0xef
        ? 3
        : lead >= 0xf0 && lead <= 0xf4
          ? 4
          : 1;
  if (expectedLen > 1 && continuations + 1 < expectedLen) {
    return bytes.subarray(0, idx);
  }
  return bytes;
}

function isLikelyTextPayload(
  feRes: SpecialtyHandoffResponse | undefined,
): boolean {
  if (!feRes) return false;
  if (feRes.file?.content !== undefined) {
    const bytes = Buffer.from(feRes.file.content.slice(0, 684), "base64");
    if (bytes.length === 0) return false;
    if (
      bytes.length >= 2 &&
      ((bytes[0] === 0xff && bytes[1] === 0xfe) ||
        (bytes[0] === 0xfe && bytes[1] === 0xff))
    ) {
      return true;
    }
    if (hasDisallowedBinaryControlByte(bytes)) return false;
    try {
      utf8FatalDecoder.decode(trimIncompleteTrailingUtf8(bytes));
      return true;
    } catch {
      return false;
    }
  }

  const sample = feRes.content.slice(0, 512);
  if (sample.length === 0) return false;
  let hasWideChar = false;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (code > 0xff) {
      hasWideChar = true;
      break;
    }
  }
  if (hasWideChar) {
    for (let i = 0; i < sample.length; i++) {
      const code = sample.charCodeAt(i);
      if (
        (code >= 0x00 && code <= 0x08) ||
        code === 0x0b ||
        (code >= 0x0e && code <= 0x1f) ||
        code === 0x7f
      ) {
        return false;
      }
    }
    return true;
  }

  const bytes = Buffer.from(sample, "latin1");
  if (
    bytes.length >= 2 &&
    ((bytes[0] === 0xff && bytes[1] === 0xfe) ||
      (bytes[0] === 0xfe && bytes[1] === 0xff))
  ) {
    return true;
  }
  if (hasDisallowedBinaryControlByte(bytes)) return false;
  try {
    utf8FatalDecoder.decode(trimIncompleteTrailingUtf8(bytes));
    return true;
  } catch {
    return false;
  }
}

function isDisallowedContainerPayload(
  kind: HandoffFileKind | null,
  mediaType: string | undefined,
  attachmentBinaryExt: string | null,
  urlString: string | undefined,
): boolean {
  if (kind === "zip") {
    return (
      (mediaType !== undefined && ZIP_ARCHIVE_MEDIA_TYPES.has(mediaType)) ||
      attachmentBinaryExt !== null ||
      hasBinaryOrGzipArchiveUrlExtension(urlString)
    );
  }
  if (kind === "ole") {
    let urlExt = "";
    if (urlString) {
      try {
        urlExt = path.extname(new URL(urlString).pathname).toLowerCase();
      } catch {}
    }
    return (
      (mediaType !== undefined && OLE_INSTALLER_MEDIA_TYPES.has(mediaType)) ||
      attachmentBinaryExt !== null ||
      OLE_INSTALLER_EXTENSIONS.has(urlExt) ||
      hasBinaryOrGzipArchiveUrlExtension(urlString)
    );
  }
  return false;
}

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

  const attachmentBinaryExt = binaryAttachmentExtension(headers);

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
    const isHeaderlessBinaryContainer = isDisallowedContainerPayload(
      headerlessFile,
      undefined,
      attachmentBinaryExt,
      feRes?.url,
    );
    if (headerlessFile !== null && !isHeaderlessBinaryContainer) {
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
    if (
      !isAllowedGzipFileHandoff(feRes, undefined, attachmentBinaryExt) &&
      (isHeaderlessBinaryContainer ||
        attachmentBinaryExt !== null ||
        hasNullBytesWithoutUtf16Bom(feRes))
    ) {
      throw new UnsupportedFileError(
        attachmentBinaryExt ??
          (headerlessFile === "zip"
            ? "application/zip"
            : "application/octet-stream"),
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
  const isBinaryContainer = isDisallowedContainerPayload(
    sniffedFile,
    mediaType,
    attachmentBinaryExt,
    feRes?.url,
  );
  if (sniffedFile !== null && !isBinaryContainer) {
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

  if (isBinaryContainer) {
    throw new UnsupportedFileError(contentType);
  }

  // Reject explicit binary content types (unsupported images, video, audio,
  // installers, disk images, archives), and reject generic octet-stream or
  // download headers unless the leading bytes are valid UTF-8/UTF-16 text
  // without binary attachment or archive extensions.
  const explicitUnsupportedBinaryPrefixes = [
    "image/",
    "video/",
    "audio/",
    "font/",
    "application/zip",
    "application/x-zip-compressed",
    "application/x-tar",
    "application/x-rar",
    "application/vnd.rar",
    "application/x-7z",
    "application/gzip",
    "application/x-gzip",
    "application/x-bzip2",
    "application/x-xz",
    "application/zstd",
    "application/wasm",
    "application/x-executable",
    "application/x-sharedlib",
    "application/x-msdownload",
    "application/x-msdos-program",
    "application/x-dosexec",
    "application/vnd.microsoft.portable-executable",
    "application/x-msi",
    "application/vnd.ms-msi",
    "application/x-ole-storage",
    "application/x-apple-diskimage",
    "application/x-dmg",
    "application/x-iso9660-image",
    "application/vnd.debian.binary-package",
    "application/x-debian-package",
    "application/x-rpm",
    "application/x-redhat-package-manager",
    "application/vnd.android.package-archive",
    "application/x-xpinstall",
    "application/x-chrome-extension",
    "application/java-archive",
    "application/font-woff",
    "application/vnd.ms-fontobject",
  ];
  const isGenericBinaryPayload =
    GENERIC_OCTET_MEDIA_TYPES.has(mediaType) &&
    (hasBinaryOrGzipArchiveUrlExtension(feRes?.url) ||
      !isLikelyTextPayload(feRes));

  if (
    !isAllowedGzipFileHandoff(feRes, mediaType, attachmentBinaryExt) &&
    (explicitUnsupportedBinaryPrefixes.some(prefix =>
      mediaType.startsWith(prefix),
    ) ||
      isGenericBinaryPayload ||
      attachmentBinaryExt !== null)
  ) {
    throw new UnsupportedFileError(contentType);
  }
}
