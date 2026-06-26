const DOCUMENT_CONTENT_TYPES = [
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/msword",
  "application/rtf",
  "text/rtf",
  "application/vnd.oasis.opendocument.text",
];

const UNSUPPORTED_BINARY_PREFIXES = [
  "image/",
  "video/",
  "audio/",
  "application/zip",
  "application/x-tar",
  "application/gzip",
  "application/x-rar",
  "application/x-7z",
  "application/wasm",
  "application/x-executable",
  "application/x-sharedlib",
  "application/java-archive",
];

function normalizeContentType(contentType?: string | null): string {
  return contentType?.toLowerCase() ?? "";
}

export function isPdfContentType(contentType?: string | null): boolean {
  const normalizedType = normalizeContentType(contentType);
  return (
    normalizedType === "application/pdf" ||
    normalizedType.startsWith("application/pdf;")
  );
}

export function isDocumentContentType(contentType?: string | null): boolean {
  const normalizedType = normalizeContentType(contentType);
  return DOCUMENT_CONTENT_TYPES.some(type => normalizedType.includes(type));
}

export function isUnsupportedBinaryContentType(
  contentType?: string | null,
): boolean {
  const normalizedType = normalizeContentType(contentType);
  return UNSUPPORTED_BINARY_PREFIXES.some(prefix =>
    normalizedType.startsWith(prefix),
  );
}

export function isProbablyPdfBase64(content: string): boolean {
  return content.startsWith("JVBERi0") || content.startsWith("JVBERi");
}

export function isProbablyDocumentBase64(content: string): boolean {
  return content.startsWith("UEsD") || content.startsWith("0M8R4K");
}
