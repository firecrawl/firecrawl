// Document formats handled by the document engine (anydoc). PDF is
// intentionally absent — it has its own engine with OCR support.

const CONTENT_TYPE_TO_EXTENSION = new Map<string, string>([
  [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".docx",
  ],
  ["application/vnd.ms-word.document.macroenabled.12", ".docm"],
  ["application/msword", ".doc"],
  [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xlsx",
  ],
  ["application/vnd.ms-excel", ".xls"],
  ["application/vnd.ms-excel.sheet.macroenabled.12", ".xlsm"],
  ["application/vnd.ms-excel.sheet.binary.macroenabled.12", ".xlsb"],
  [
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".pptx",
  ],
  ["application/vnd.ms-powerpoint", ".ppt"],
  ["application/vnd.ms-powerpoint.presentation.macroenabled.12", ".pptm"],
  ["application/vnd.oasis.opendocument.text", ".odt"],
  ["application/vnd.oasis.opendocument.spreadsheet", ".ods"],
  ["application/vnd.oasis.opendocument.presentation", ".odp"],
  ["application/rtf", ".rtf"],
  ["text/rtf", ".rtf"],
  ["application/epub+zip", ".epub"],
  ["text/csv", ".csv"],
]);

export const DOCUMENT_EXTENSIONS = new Set(CONTENT_TYPE_TO_EXTENSION.values());

// Longest first so ".docx" wins over ".doc" when matching URL paths.
const EXTENSIONS_BY_LENGTH = [...DOCUMENT_EXTENSIONS].sort(
  (a, b) => b.length - a.length,
);

export function documentExtensionFromContentType(
  contentType: string | null | undefined,
): string | null {
  if (!contentType) return null;
  const mediaType = contentType.split(";")[0].trim().toLowerCase();
  return CONTENT_TYPE_TO_EXTENSION.get(mediaType) ?? null;
}

export function documentContentTypeFromExtension(
  extension: string,
): string | null {
  const ext = extension.toLowerCase();
  for (const [contentType, mapped] of CONTENT_TYPE_TO_EXTENSION) {
    if (mapped === ext) return contentType;
  }
  return null;
}

// Matches extensions at the end of the path or mid-path (e.g. file.xlsx/hash).
export function documentExtensionFromUrlPath(urlPath: string): string | null {
  const lowerPath = urlPath.toLowerCase();
  for (const ext of EXTENSIONS_BY_LENGTH) {
    if (lowerPath.endsWith(ext) || lowerPath.includes(ext + "/")) return ext;
  }
  return null;
}
