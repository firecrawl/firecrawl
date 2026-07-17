import { TextDecoder } from "util";

/**
 * Decode a response body buffer into text, honoring the charset declared in the
 * Content-Type header or an HTML `<meta charset>` tag, falling back to UTF-8.
 *
 * Shared by the fetch and fire-engine engines so non-UTF-8 pages (e.g.
 * Shift_JIS, windows-1251) are not mangled by a naive `buffer.toString("utf8")`.
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

  // Match `charset` only as a standalone Content-Type parameter (preceded by
  // the start of string, whitespace, or a `;` delimiter) so a different
  // parameter such as `x-charset=` is not mistaken for a charset declaration.
  const headerCharsetRaw = (contentType?.match(
    /(?:^|[;\s])charset\s*=\s*["']?([^;"'\s]+)/i,
  ) ?? [])[1];
  const headerCharset = headerCharsetRaw?.trim();

  // Match `charset` only as a standalone attribute name (preceded by an
  // attribute boundary — whitespace or a quote) so a different attribute such
  // as `data-charset=` is not mistaken for the meta charset.
  const metaCharsetRaw = (text.match(
    /<meta\b[^>]*[\s"']charset\s*=\s*["']?([^"'\s\/>]+)/i,
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
