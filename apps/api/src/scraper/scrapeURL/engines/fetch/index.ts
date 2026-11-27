import { fetch as undiciFetch } from "undici";
import { z } from "zod";
import type { EngineScrapeResult } from "..";
import type { Meta } from "../..";
import { SSLError } from "../../error";
import { TLS_CERT_ERROR_CODES } from "../utils/safeFetch";
import { specialtyScrapeCheck } from "../utils/specialtyHandler";
import {
  getSecureDispatcher,
  InsecureConnectionError,
} from "../utils/safeFetch";
import type { MockState } from "../../lib/mock";
import { saveMock } from "../../lib/mock";
import { TextDecoder } from "node:util";

interface DecodedHtmlResult {
  text: string;
  charset?: string;
  charsetSource?: "header" | "meta";
  decodeError?: unknown;
}

const fetchResponseDataSchema = z.object({
  url: z.string(),
  body: z.string(),
  status: z.number(),
  headers: z.array(z.tuple([z.string(), z.string()])),
});

type FetchResponseData = z.infer<typeof fetchResponseDataSchema>;

function makeRequestTypeId(
  request: MockState["requests"][number]["options"],
): string {
  return request.url + ";" + request.method;
}

const errorWithCodeSchema = z.object({ code: z.string() });

function getErrorCode(value: unknown): string | undefined {
  const parsed = errorWithCodeSchema.safeParse(value);
  return parsed.success ? parsed.data.code : undefined;
}

function decodeHtmlBuffer(
  buf: Buffer,
  contentType?: string,
): DecodedHtmlResult {
  const text = buf.toString("utf8");

  const headerCharsetRaw = (
    contentType?.match(/charset\s*=\s*["']?([^;"'\s]+)/i) ?? []
  )[1];
  const headerCharset = headerCharsetRaw?.trim();

  const metaCharsetRaw = (
    text.match(/<meta\b[^>]*charset\s*=\s*["']?([^"'\s/>]+)/i) ?? []
  )[1];
  const metaCharset = metaCharsetRaw?.trim();

  if (headerCharset) {
    try {
      return {
        text: new TextDecoder(headerCharset).decode(buf),
        charset: headerCharset,
        charsetSource: "header",
      };
    } catch (headerDecodeError: unknown) {
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
    } catch (decodeError: unknown) {
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

  let response: FetchResponseData;

  if (meta.fetchPrefetch !== undefined && meta.fetchPrefetch !== null) {
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
    const thisId = makeRequestTypeId(mockOptions);
    const matchingMocks = meta.mock.requests
      .filter(x => makeRequestTypeId(x.options) === thisId)
      .sort((a, b) => a.time - b.time);
    const nextI = meta.mock.tracker[thisId] ?? 0;
    meta.mock.tracker[thisId] = nextI + 1;

    if (!matchingMocks[nextI]) {
      throw new Error("Failed to mock request -- no mock targets found.");
    }

    response = fetchResponseDataSchema.parse({
      ...matchingMocks[nextI].result,
      url: matchingMocks[nextI].result.url ?? meta.rewrittenUrl ?? meta.url,
    });
  } else {
    try {
      const x = await undiciFetch(meta.rewrittenUrl ?? meta.url, {
        dispatcher: getSecureDispatcher(meta.options.skipTlsVerification),
        redirect: "follow",
        headers: meta.options.headers,
        signal: meta.abort.asSignal(),
      });

      const buf = Buffer.from(await x.arrayBuffer());
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
        headers: [...x.headers],
      };

      if (meta.mock === null) {
        await saveMock(mockOptions, response);
      }
    } catch (error: unknown) {
      const causeCode =
        error instanceof Error ? getErrorCode(error.cause) : undefined;
      if (
        error instanceof TypeError &&
        error.cause instanceof InsecureConnectionError
      ) {
        throw error.cause;
      } else if (
        error instanceof Error &&
        error.message === "fetch failed" &&
        causeCode !== undefined &&
        TLS_CERT_ERROR_CODES.has(causeCode)
      ) {
        throw new SSLError(meta.options.skipTlsVerification);
      } else {
        throw error;
      }
    }
  }

  await specialtyScrapeCheck(
    meta.logger.child({ method: "scrapeURLWithFetch/specialtyScrapeCheck" }),
    Object.fromEntries(response.headers),
  );

  return {
    url: response.url,
    html: response.body,
    statusCode: response.status,
    contentType:
      (
        response.headers.find(x => x[0].toLowerCase() === "content-type") ?? []
      )[1] ?? undefined,

    proxyUsed: "basic",
  };
}

export function fetchMaxReasonableTime(meta: Meta): number {
  return 15_000;
}
