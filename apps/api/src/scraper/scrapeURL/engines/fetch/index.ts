import * as undici from "undici";
import { EngineScrapeResult } from "..";
import { Meta } from "../..";
import { SSLError, UnsupportedFileError } from "../../error";
import { TLS_CERT_ERROR_CODES } from "../utils/safeFetch";
import { specialtyScrapeCheck } from "../utils/specialtyHandler";
import {
  getSecureDispatcher,
  InsecureConnectionError,
} from "../utils/safeFetch";
import { MAX_GUNZIPPED_FILE_SIZE } from "../utils/gunzip";
import { MockState, saveMock } from "../../lib/mock";
import { TextDecoder } from "util";

export const FETCH_MAX_RESPONSE_BYTES = MAX_GUNZIPPED_FILE_SIZE;
const FETCH_SNIFF_PREFIX_BYTES = 512;

async function readFetchResponseBounded(
  x: undici.Response,
  meta: Meta,
  maxBytes: number = FETCH_MAX_RESPONSE_BYTES,
): Promise<{ buf: Buffer; headers: [string, string][] }> {
  const headers: [string, string][] = [...x.headers];
  const headersRecord = Object.fromEntries(headers);

  if (x.body === null) {
    await specialtyScrapeCheck(
      meta.logger.child({ method: "scrapeURLWithFetch/specialtyScrapeCheck" }),
      headersRecord,
      {
        url: x.url,
        content: "",
        pageStatusCode: x.status,
        responseHeaders: headersRecord,
      },
      meta.abort.asSignal(),
      undefined,
      meta.imageOcrEnabled,
    );
    return { buf: Buffer.alloc(0), headers };
  }

  const reader = x.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  let streamDone = false;

  try {
    // Read only enough leading bytes to sniff magic signatures before buffering
    // the full response, so binary downloads (installers, archives, PDFs, Office
    // files) are rejected or handed off without loading hundreds of MB into RAM.
    while (bytesRead < FETCH_SNIFF_PREFIX_BYTES) {
      const { done, value } = await reader.read();
      if (done) {
        streamDone = true;
        break;
      }
      if (value && value.byteLength > 0) {
        bytesRead += value.byteLength;
        if (bytesRead > maxBytes) {
          throw new UnsupportedFileError("File exceeds size limit");
        }
        chunks.push(value);
      }
    }

    const prefixLen = Math.min(bytesRead, FETCH_SNIFF_PREFIX_BYTES);
    const prefixSlice =
      prefixLen === 0
        ? Buffer.alloc(0)
        : chunks.length === 1
          ? Buffer.from(chunks[0].buffer, chunks[0].byteOffset, prefixLen)
          : Buffer.concat(chunks, prefixLen);

    await specialtyScrapeCheck(
      meta.logger.child({ method: "scrapeURLWithFetch/specialtyScrapeCheck" }),
      headersRecord,
      {
        url: x.url,
        content: prefixSlice.toString("latin1"),
        pageStatusCode: x.status,
        responseHeaders: headersRecord,
      },
      meta.abort.asSignal(),
      undefined,
      meta.imageOcrEnabled,
    );

    const contentLengthHeader = x.headers.get("content-length");
    if (contentLengthHeader !== null) {
      const declared = Number(contentLengthHeader);
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new UnsupportedFileError("File exceeds size limit");
      }
    }

    while (!streamDone) {
      const { done, value } = await reader.read();
      if (done) {
        streamDone = true;
        break;
      }
      if (value && value.byteLength > 0) {
        bytesRead += value.byteLength;
        if (bytesRead > maxBytes) {
          throw new UnsupportedFileError("File exceeds size limit");
        }
        chunks.push(value);
      }
    }

    return { buf: Buffer.concat(chunks, bytesRead), headers };
  } catch (error) {
    if (!streamDone) {
      await reader.cancel().catch(() => {});
    }
    throw error;
  }
}

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

export async function scrapeURLWithFetch(
  meta: Meta,
): Promise<EngineScrapeResult> {
  const mockOptions = {
    url: meta.rewrittenUrl ?? meta.url,

    // irrelevant
    method: "GET",
    ignoreResponse: false,
    ignoreFailure: false,
    tryCount: 1,
  };

  let response: {
    url: string;
    body: string;
    status: number;
    headers: [string, string][];
  };

  let checkedSpecialty = false;
  let sniffContent = "";

  if (meta.fetchPrefetch !== undefined && meta.fetchPrefetch !== null) {
    if (meta.fetchPrefetch.bodyBuffer.byteLength > FETCH_MAX_RESPONSE_BYTES) {
      throw new UnsupportedFileError("File exceeds size limit");
    }
    sniffContent = meta.fetchPrefetch.bodyBuffer
      .subarray(0, FETCH_SNIFF_PREFIX_BYTES)
      .toString("latin1");
    const { text, charset, charsetSource, decodeError } = decodeHtmlBuffer(
      meta.fetchPrefetch.bodyBuffer,
      meta.fetchPrefetch.contentType,
    );
    if (decodeError) {
      meta.logger.warn(
        "Failed to re-parse uploaded HTML with detected charset",
        {
          charset,
          charsetSource,
          error: decodeError,
        },
      );
    } else if (charset) {
      meta.logger.debug("Decoded uploaded HTML using detected charset", {
        charset,
        charsetSource,
      });
    }

    response = {
      url: meta.fetchPrefetch.url ?? meta.rewrittenUrl ?? meta.url,
      body: text,
      status: meta.fetchPrefetch.status,
      headers: meta.fetchPrefetch.contentType
        ? [["content-type", meta.fetchPrefetch.contentType]]
        : [],
    };
  } else if (meta.mock !== null) {
    const makeRequestTypeId = (
      request: MockState["requests"][number]["options"],
    ) => request.url + ";" + request.method;

    const thisId = makeRequestTypeId(mockOptions);
    const matchingMocks = meta.mock.requests
      .filter(x => makeRequestTypeId(x.options) === thisId)
      .sort((a, b) => a.time - b.time);
    const nextI = meta.mock.tracker[thisId] ?? 0;
    meta.mock.tracker[thisId] = nextI + 1;

    if (!matchingMocks[nextI]) {
      throw new Error("Failed to mock request -- no mock targets found.");
    }

    response = {
      ...matchingMocks[nextI].result,
    };
    if (Buffer.byteLength(response.body, "utf8") > FETCH_MAX_RESPONSE_BYTES) {
      throw new UnsupportedFileError("File exceeds size limit");
    }
    sniffContent = response.body.slice(0, FETCH_SNIFF_PREFIX_BYTES);
  } else {
    try {
      const x = await undici.fetch(meta.rewrittenUrl ?? meta.url, {
        dispatcher: getSecureDispatcher(meta.options.skipTlsVerification),
        redirect: "follow",
        headers: meta.options.headers,
        signal: meta.abort.asSignal(),
      });

      const { buf, headers } = await readFetchResponseBounded(x, meta);
      checkedSpecialty = true;
      const contentType = x.headers.get("content-type") ?? undefined;
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
        headers,
      };

      if (meta.mock === null) {
        await saveMock(mockOptions, response);
      }
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
        TLS_CERT_ERROR_CODES.has((error.cause as any).code)
      ) {
        throw new SSLError(meta.options.skipTlsVerification);
      } else {
        throw error;
      }
    }
  }

  if (!checkedSpecialty) {
    const headersRecord = Object.fromEntries(response.headers as any);
    await specialtyScrapeCheck(
      meta.logger.child({
        method: "scrapeURLWithFetch/specialtyScrapeCheck",
      }),
      headersRecord,
      {
        url: response.url,
        content: sniffContent,
        pageStatusCode: response.status,
        responseHeaders: headersRecord,
      },
      meta.abort.asSignal(),
      undefined,
      meta.imageOcrEnabled,
    );
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

export function fetchMaxReasonableTime(meta: Meta): number {
  return 15000;
}
