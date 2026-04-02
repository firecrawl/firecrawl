import { Meta } from "..";
import { Document } from "../../../controllers/v2/types";

// U+2028 (Line Separator) and U+2029 (Paragraph Separator) are valid Unicode
// but act as line terminators in JavaScript. When these appear inside JSON
// strings transmitted over JSONL (e.g. MCP stdio), they split the line mid-
// string and cause "Unterminated string in JSON at position X" parse errors.
// We replace them with their ASCII equivalents to preserve document structure:
//   U+2028 → \n   (line break)
//   U+2029 → \n\n (paragraph break)

function sanitize(str: string): string {
  return str.replace(/\u2029/g, "\n\n").replace(/\u2028/g, "\n");
}

export function sanitizeUnicodeLineTerminators(
  _meta: Meta,
  document: Document,
): Document {
  if (document.markdown !== undefined) {
    document.markdown = sanitize(document.markdown);
  }
  if (document.html !== undefined) {
    document.html = sanitize(document.html);
  }
  if (document.rawHtml !== undefined) {
    document.rawHtml = sanitize(document.rawHtml);
  }
  return document;
}
