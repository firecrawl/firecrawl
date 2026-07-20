import { TextDecoder } from "util";

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
  let text = buf.toString("utf8");

  const headerCharsetRaw = (contentType?.match(
    /charset\s*=\s*["']?([^;"'\s]+)/i,
  ) ?? [])[1];
  const headerCharset = headerCharsetRaw?.trim();

  const metaCharsetRaw = (text.match(
    /<meta\b[^>]*charset\s*=\s*["']?([^"'\s\/>]+)/i,
  ) ?? [])[1];
  const metaCharset = metaCharsetRaw?.trim();

  if (headerCharset) {
    try {
      return {
        text: new TextDecoder(headerCharset).decode(buf),
        charset: headerCharset,
        charsetSource: "header",
      };
    } catch (headerDecodeError) {
      // If header charset is invalid/unsupported, fall back to meta charset.
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
        text,
        charset: headerCharset,
        charsetSource: "header",
        decodeError: headerDecodeError,
      };
    }
  }

  if (metaCharset) {
    try {
      return {
        text: new TextDecoder(metaCharset).decode(buf),
        charset: metaCharset,
        charsetSource: "meta",
      };
    } catch (decodeError) {
      return {
        text,
        charset: metaCharset,
        charsetSource: "meta",
        decodeError,
      };
    }
  }

  return { text };
}