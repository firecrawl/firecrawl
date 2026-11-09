import { DOCUMENT_CONTENT_TYPE_TO_EXTENSION } from "./document-formats";
import {
  IMAGE_CONTENT_TYPE_TO_EXTENSION,
  IMAGE_EXTENSION_ALIASES,
} from "./image-formats";

export const PDF_EXTENSIONS = [".pdf"];
export const PDF_CONTENT_TYPES = ["application/pdf"];
export const HTML_EXTENSIONS = [".html", ".htm", ".xhtml"];
export const HTML_CONTENT_TYPES = ["text/html", "application/xhtml+xml"];

export type ParseFormat = {
  format: string;
  kind: "document" | "image";
  extensions: string[];
  mimeTypes: string[];
  available: boolean;
};

function groupByExtension(
  kind: ParseFormat["kind"],
  available: boolean,
  contentTypeToExtension: ReadonlyMap<string, string>,
  aliases: ReadonlyMap<string, string> = new Map(),
): ParseFormat[] {
  const formats = new Map<string, ParseFormat>();
  for (const [mimeType, extension] of contentTypeToExtension) {
    const format = formats.get(extension) ?? {
      format: extension.slice(1),
      kind,
      extensions: [extension],
      mimeTypes: [],
      available,
    };
    format.mimeTypes.push(mimeType);
    formats.set(extension, format);
  }
  for (const [alias, extension] of aliases) {
    formats.get(extension)?.extensions.push(alias);
  }
  return [...formats.values()];
}

/**
 * Every upload type /v2/parse accepts, built from the same constants
 * detectUploadedFileKind validates against. Image formats are only
 * `available` where image OCR is enabled.
 */
export function listParseFormats(imageOcrEnabled: boolean): ParseFormat[] {
  return [
    {
      format: "html",
      kind: "document",
      extensions: [...HTML_EXTENSIONS],
      mimeTypes: [...HTML_CONTENT_TYPES],
      available: true,
    },
    {
      format: "pdf",
      kind: "document",
      extensions: [...PDF_EXTENSIONS],
      mimeTypes: [...PDF_CONTENT_TYPES],
      available: true,
    },
    ...groupByExtension("document", true, DOCUMENT_CONTENT_TYPE_TO_EXTENSION),
    ...groupByExtension(
      "image",
      imageOcrEnabled,
      IMAGE_CONTENT_TYPE_TO_EXTENSION,
      IMAGE_EXTENSION_ALIASES,
    ),
  ];
}
