import { Logger } from "winston";
import path from "path";
import os from "os";
import { writeFile } from "fs/promises";
import { Meta } from "../..";

export type SpecialtyType = "pdf" | "document";

export type SpecialtyPlan = {
  type: SpecialtyType;
  contentType?: string;
  prefetch?: Meta["pdfPrefetch"] | Meta["documentPrefetch"];
};

type SpecialtyDetectionInput = {
  headers?: Record<string, string>;
  contentType?: string;
  body?: string;
  binaryFile?: {
    content: string;
    name?: string;
  };
  url?: string;
  status?: number;
  proxyUsed?: "basic" | "stealth";
};

const documentTypes = [
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/msword",
  "application/rtf",
  "text/rtf",
  "application/vnd.oasis.opendocument.text",
];

function getHeaderContentType(
  headers: Record<string, string> | undefined,
  fallback?: string,
): string | undefined {
  if (fallback) {
    return fallback;
  }

  return (Object.entries(headers ?? {}).find(
    x => x[0].toLowerCase() === "content-type",
  ) ?? [])[1];
}

function getDocumentExtension(contentType: string | undefined): string {
  if (!contentType) {
    return "tmp";
  }

  if (
    contentType.includes("wordprocessingml") ||
    contentType.includes("msword")
  ) {
    return "docx";
  }

  if (
    contentType.includes("spreadsheetml") ||
    contentType.includes("ms-excel")
  ) {
    return "xlsx";
  }

  if (contentType.includes("opendocument.text")) {
    return "odt";
  }

  if (contentType.includes("rtf")) {
    return "rtf";
  }

  return "tmp";
}

async function base64ToPrefetch(
  logger: Logger,
  contentBase64: string,
  fileExtension: string,
  fileType: SpecialtyType,
  context: Pick<SpecialtyDetectionInput, "url" | "status" | "proxyUsed"> & {
    contentType?: string;
  },
): Promise<Meta["pdfPrefetch"] | Meta["documentPrefetch"]> {
  const filePath = path.join(
    os.tmpdir(),
    `tempFile-${crypto.randomUUID()}.${fileExtension}`,
  );

  try {
    await writeFile(filePath, Buffer.from(contentBase64, "base64"));
  } catch (error) {
    logger.error(`Failed to write ${fileType} prefetch file`, {
      error,
      filePath,
    });
    throw error;
  }

  return {
    status: context.status ?? 200,
    url: context.url,
    filePath,
    proxyUsed: context.proxyUsed ?? "basic",
    contentType: context.contentType,
  };
}

function hasPdfSignature(body?: string, binaryContent?: string): boolean {
  const raw = body ?? "";
  const base64 = binaryContent ?? "";
  return (
    raw.startsWith("%PDF-") ||
    raw.startsWith("JVBERi0") ||
    base64.startsWith("JVBERi0")
  );
}

function hasDocumentSignature(body?: string, binaryContent?: string): boolean {
  const raw = body ?? "";
  const base64 = binaryContent ?? "";
  return (
    raw.startsWith("PK") ||
    raw.startsWith("UEsD") ||
    base64.startsWith("UEsD")
  );
}

export async function detectSpecialtyPlan(
  logger: Logger,
  input: SpecialtyDetectionInput,
): Promise<SpecialtyPlan | undefined> {
  const contentType = getHeaderContentType(input.headers, input.contentType);
  const normalizedContentType = contentType?.toLowerCase();
  const binaryContent = input.binaryFile?.content;

  if (!normalizedContentType && !input.body && !binaryContent) {
    logger.warn("Failed to detect specialty type: no content or headers");
    return undefined;
  }

  const isDocument = documentTypes.some(type =>
    normalizedContentType?.startsWith(type),
  );
  const isPdf =
    normalizedContentType === "application/pdf" ||
    normalizedContentType?.startsWith("application/pdf;");
  const isOctetStream =
    normalizedContentType === "application/octet-stream" ||
    normalizedContentType?.startsWith("application/octet-stream;");

  if (isDocument || (isOctetStream && hasDocumentSignature(input.body, binaryContent))) {
    const prefetch = binaryContent
      ? await base64ToPrefetch(
          logger,
          binaryContent,
          getDocumentExtension(normalizedContentType),
          "document",
          {
            url: input.url,
            status: input.status,
            proxyUsed: input.proxyUsed,
            contentType: normalizedContentType,
          },
        )
      : undefined;

    return {
      type: "document",
      contentType: normalizedContentType,
      prefetch,
    };
  }

  if (isPdf || (isOctetStream && hasPdfSignature(input.body, binaryContent))) {
    const prefetch = binaryContent
      ? await base64ToPrefetch(logger, binaryContent, "pdf", "pdf", {
          url: input.url,
          status: input.status,
          proxyUsed: input.proxyUsed,
          contentType: normalizedContentType,
        })
      : undefined;

    return {
      type: "pdf",
      contentType: normalizedContentType,
      prefetch,
    };
  }

  if (!normalizedContentType && hasDocumentSignature(input.body, binaryContent)) {
    return {
      type: "document",
      contentType: normalizedContentType,
    };
  }

  if (!normalizedContentType && hasPdfSignature(input.body, binaryContent)) {
    return {
      type: "pdf",
      contentType: normalizedContentType,
    };
  }

  return undefined;
}
