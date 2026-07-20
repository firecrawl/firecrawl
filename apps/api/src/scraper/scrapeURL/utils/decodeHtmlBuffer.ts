import { TextDecoder } from "util";

/**
 * Extracts a charset label from an HTML prologue fragment.
 *
 * Only matches the two standard declaration forms:
 *   1. <meta charset="...">           (HTML5)
 *   2. <meta http-equiv="content-type" content="...; charset=...">
 *
 * This avoids false positives where the text "charset=..." appears inside
 * an unrelated attribute value or in body/script content.
 *
 * @returns The trimmed charset label, or undefined if none found.
 */
function extractMetaCharset(prologue: string): string | undefined {
  // Form 1: <meta charset="utf-8">
  const simpleMatch = prologue.match(
    /<meta\s+charset\s*=\s*["']?([^"'\s\/>]+)/i,
  );
  if (simpleMatch?.[1]) {
    return simpleMatch[1].trim();
  }

  // Form 2: <meta http-equiv="content-type" content="text/html; charset=utf-8">
  const httpEquivMatch = prologue.match(
    /<meta\b[^>]*http-equiv\s*=\s*["']?content-type["']?[^>]*content\s*=\s*["'][^"']*charset\s*=\s*([^;"'\s]+)["']/i,
  );
  if (httpEquivMatch?.[1]) {
    return httpEquivMatch[1].trim();
  }

  return undefined;
}

/**
 * Decodes a Buffer to a string, detecting the charset from the Content-Type
 * header and/or HTML <meta charset> tag. Falls back to UTF-8 if no charset
 * is detected or if the detected charset is unsupported.
 *
 * This mirrors the behavior of browsers: the Content-Type header is checked
 * first, then the HTML prologue's <meta charset> / <meta http-equiv> tags.
 *
 * @param buf - The raw bytes to decode
 * @param contentType - The Content-Type response header value (may include charset)
 * @returns The decoded string and metadata about which charset was used
 */
export function decodeHtmlBuffer(
  buf: Buffer,
  contentType?: string,
): {
  text: string;
  charset?: string;
  charsetSource?: "header" | "meta";
  decodeError?: unknown;
} {
  const headerCharsetRaw = (contentType?.match(
    /charset\s*=\s*["']?([^;"'\s]+)/i,
  ) ?? [])[1];
  const headerCharset = headerCharsetRaw?.trim();

  // When the header supplies a valid charset, decode directly from the buffer
  // without first doing a full UTF-8 decode for meta sniffing. This avoids
  // decoding large responses (up to 50 MB) twice.
  if (headerCharset) {
    try {
      return {
        text: new TextDecoder(headerCharset).decode(buf),
        charset: headerCharset,
        charsetSource: "header",
      };
    } catch (headerDecodeError) {
      // Header charset is invalid/unsupported — fall through to meta detection.
      // We still need a UTF-8 string for meta scanning, but only do it on the
      // fallback path (not the common path where the header charset is valid).
      const prologue = buf.subarray(0, 1024).toString("utf8");
      const metaCharset = extractMetaCharset(prologue);

      if (
        metaCharset &&
        metaCharset.toLowerCase() !== headerCharset.toLowerCase()
      ) {
        try {
          return {
            text: new TextDecoder(metaCharset).decode(buf),
            charset: metaCharset,
            charsetSource: "meta",
          };
        } catch {
          // Keep original header decode error for logging and utf8 fallback.
        }
      }
      return {
        text: buf.toString("utf8"),
        charset: headerCharset,
        charsetSource: "header",
        decodeError: headerDecodeError,
      };
    }
  }

  // No header charset — scan only the HTML prologue (first 1024 bytes) for a
  // meta charset declaration. Browsers only honor charset declarations in the
  // prologue; scanning the entire body risks matching unrelated content.
  const prologue = buf.subarray(0, 1024).toString("utf8");
  const metaCharset = extractMetaCharset(prologue);

  if (metaCharset) {
    try {
      return {
        text: new TextDecoder(metaCharset).decode(buf),
        charset: metaCharset,
        charsetSource: "meta",
      };
    } catch (decodeError) {
      return {
        text: buf.toString("utf8"),
        charset: metaCharset,
        charsetSource: "meta",
        decodeError,
      };
    }
  }

  return { text: buf.toString("utf8") };
}