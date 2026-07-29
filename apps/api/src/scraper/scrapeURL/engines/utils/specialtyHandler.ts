import { Logger } from "winston";
import { AddFeatureError, UnsupportedFileError } from "../../error";
import { FireEngineCheckStatusSuccess } from "../fire-engine/checkStatus";
import path from "path";
import os from "os";
import { writeFile } from "fs/promises";
import { Meta } from "../..";
import { resolveProxyUsed } from "..";

async function feResToFilePrefetch(
  logger: Logger,
  feRes: FireEngineCheckStatusSuccess | undefined,
  fileExtension: string,
  fileType: string,
  contentType?: string,
  proxyOption?: string,
): Promise<Meta["pdfPrefetch"] | Meta["documentPrefetch"]> {
  if (!feRes?.file) {
    logger.warn(`No file in ${fileType} prefetch`);
    return null;
  }

  const filePath = path.join(
    os.tmpdir(),
    `tempFile-${crypto.randomUUID()}.${fileExtension}`,
  );
  await writeFile(filePath, Buffer.from(feRes.file.content, "base64"));

  return {
    status: feRes.pageStatusCode,
    url: feRes.url,
    filePath,
    proxyUsed: resolveProxyUsed(feRes.usedMobileProxy, proxyOption),
    contentType,
  };
}

async function feResToPdfPrefetch(
  logger: Logger,
  feRes: FireEngineCheckStatusSuccess | undefined,
  proxyOption?: string,
): Promise<Meta["pdfPrefetch"]> {
  return feResToFilePrefetch(
    logger,
    feRes,
    "pdf",
    "pdf",
    undefined,
    proxyOption,
  );
}

async function feResToDocumentPrefetch(
  logger: Logger,
  feRes: FireEngineCheckStatusSuccess | undefined,
  contentType: string,
  proxyOption?: string,
): Promise<Meta["documentPrefetch"]> {
  // Determine file extension from content type
  let extension = "tmp";
  if (contentType.includes("wordprocessingml")) {
    // Modern .docx format (Office Open XML)
    extension = "docx";
  } else if (contentType.includes("msword")) {
    // Legacy .doc format (OLE2/CFB binary)
    extension = "doc";
  } else if (
    contentType.includes("spreadsheetml") ||
    contentType.includes("ms-excel")
  ) {
    extension = "xlsx";
  } else if (contentType.includes("opendocument.text")) {
    extension = "odt";
  } else if (contentType.includes("rtf")) {
    extension = "rtf";
  }

  return feResToFilePrefetch(
    logger,
    feRes,
    extension,
    "document",
    contentType,
    proxyOption,
  );
}

export async function specialtyScrapeCheck(
  logger: Logger,
  headers: Record<string, string> | undefined,
  feRes?: FireEngineCheckStatusSuccess,
  proxyOption?: string,
) {
  const contentType = (Object.entries(headers ?? {}).find(
    x => x[0].toLowerCase() === "content-type",
  ) ?? [])[1];

  if (!contentType) {
    logger.warn("Failed to check contentType -- was not present in headers", {
      headers,
    });
    return;
  }

  const documentTypes = [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel",
    "application/msword",
    "application/rtf",
    "text/rtf",
    "application/vnd.oasis.opendocument.text",
  ];

  const isDocument = documentTypes.some(type => contentType.startsWith(type));
  const isPdf =
    contentType === "application/pdf" ||
    contentType.startsWith("application/pdf;");
  const isOctetStream = contentType === "application/octet-stream";

  // Check for document types first (before PDF to prioritize documents)
  if (isDocument) {
    throw new AddFeatureError(
      ["document"],
      undefined,
      await feResToDocumentPrefetch(logger, feRes, contentType, proxyOption),
    );
  }

  // Check for octet-stream with document signature
  // Modern Office files (.docx, .xlsx) are ZIP archives starting with "PK" (base64: "UEsD")
  // Legacy Office files (.doc, .xls) are OLE2/CFB files starting with D0 CF 11 E0 (base64: "0M8R4K")
  if (isOctetStream) {
    const isZipSignature =
      feRes?.file?.content.startsWith("UEsD") ||
      feRes?.content.startsWith("PK");
    const isOleSignature =
      feRes?.file?.content.startsWith("0M8R4K") ||
      feRes?.content.startsWith("\xD0\xCF\x11\xE0");

    if (isZipSignature) {
      throw new AddFeatureError(
        ["document"],
        undefined,
        await feResToDocumentPrefetch(logger, feRes, contentType, proxyOption),
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
        await feResToDocumentPrefetch(
          logger,
          feRes,
          effectiveContentType,
          proxyOption,
        ),
      );
    }
  }

  // Check for PDF
  if (isPdf) {
    throw new AddFeatureError(
      ["pdf"],
      await feResToPdfPrefetch(logger, feRes, proxyOption),
    );
  }

  // Check for octet-stream with PDF signature
  if (
    isOctetStream &&
    (feRes?.file?.content.startsWith("JVBERi0") ||
      feRes?.content.startsWith("%PDF-"))
  ) {
    throw new AddFeatureError(
      ["pdf"],
      await feResToPdfPrefetch(logger, feRes, proxyOption),
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
