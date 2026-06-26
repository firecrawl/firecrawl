import * as undici from "undici";
import { SSLError, UnsupportedFileError } from "../../error";
import {
  getSecureDispatcher,
  InsecureConnectionError,
} from "../utils/safeFetch";
import { TextDecoder } from "util";
import { Meta } from "../../lib/meta";
import { Engine, EngineScrapeResult } from "../types";
import { attachEngineResultFile } from "../../lib/engine-result-file";
import {
  isDocumentContentType,
  isPdfContentType,
  isProbablyDocumentBase64,
  isProbablyPdfBase64,
  isUnsupportedBinaryContentType,
} from "../../lib/file-format-check";

function decodeHtmlBuffer(
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

async function scrapeURLWithFetch(meta: Meta): Promise<EngineScrapeResult> {
  let response: {
    url: string;
    body: string;
    status: number;
    headers: [string, string][];
  };

  try {
    const x = await undici.fetch(meta.rewrittenUrl ?? meta.url, {
      dispatcher: getSecureDispatcher(meta.options.skipTlsVerification),
      redirect: "follow",
      headers: meta.options.headers,
      signal: meta.abort.asSignal(),
    });

    const buf = Buffer.from(await x.arrayBuffer());
    const contentType = x.headers.get("content-type") ?? undefined;
    const base64 = buf.toString("base64");
    const shouldKeepAsBase64 =
      isPdfContentType(contentType) ||
      isDocumentContentType(contentType) ||
      isProbablyPdfBase64(base64) ||
      isProbablyDocumentBase64(base64);

    if (!shouldKeepAsBase64 && isUnsupportedBinaryContentType(contentType)) {
      throw new UnsupportedFileError(contentType ?? "unknown");
    }

    if (shouldKeepAsBase64) {
      response = {
        url: x.url,
        body: base64,
        status: x.status,
        headers: [...x.headers],
      };
      const result: EngineScrapeResult = {
        url: response.url,
        html: response.body,
        statusCode: response.status,
        contentType:
          (response.headers.find(x => x[0].toLowerCase() === "content-type") ??
            [])[1] ?? undefined,
        proxyUsed: "basic",
      };

      return attachEngineResultFile(result, { content: response.body });
    }

    const { text, charset, charsetSource, decodeError } = decodeHtmlBuffer(
      buf,
      contentType,
    );
    if (decodeError) {
      meta.logger.warn(
        "Failed to re-parse fetched HTML with detected charset",
        {
          charset,
          charsetSource,
          error: decodeError,
        },
      );
    } else if (charset) {
      meta.logger.debug("Decoded fetched HTML using detected charset", {
        charset,
        charsetSource,
      });
    }

    response = {
      url: x.url,
      body: text,
      status: x.status,
      headers: [...x.headers],
    };
  } catch (error) {
    if (
      error instanceof TypeError &&
      error.cause instanceof InsecureConnectionError
    ) {
      throw error.cause;
    } else if (
      error instanceof Error &&
      error.message === "fetch failed" &&
      error.cause &&
      (error.cause as any).code === "CERT_HAS_EXPIRED"
    ) {
      throw new SSLError(meta.options.skipTlsVerification);
    } else {
      throw error;
    }
  }

  return {
    url: response.url,
    html: response.body,
    statusCode: response.status,
    contentType:
      (response.headers.find(x => x[0].toLowerCase() === "content-type") ??
        [])[1] ?? undefined,

    proxyUsed: "basic",
  };
}

export const fetchEngine: Engine = {
  name: "fetch",
  features: {
    actions: false,
    waitFor: false,
    screenshot: false,
    "screenshot@fullScreen": false,
    audio: false,
    video: false,
    atsv: false,
    location: false,
    mobile: false,
    branding: false,
    disableAdblock: false,
  },
  scrape: meta => {
    const logger = meta.logger.child({
      method: "scrapeURLWithFetch",
      engine: "fetch",
    });

    return scrapeURLWithFetch({
      ...meta,
      logger,
    });
  },
};
