import * as undici from "undici";
import { EngineScrapeResult } from "..";
import { Meta } from "../..";
import { SSLError } from "../../error";
import { specialtyScrapeCheck } from "../utils/specialtyHandler";
import {
  getSecureDispatcher,
  InsecureConnectionError,
} from "../utils/safeFetch";
import { MockState, saveMock } from "../../lib/mock";
import { TextDecoder } from "util";

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

  if (meta.mock !== null) {
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
  } else {
    try {
      const x = await undici.fetch(meta.rewrittenUrl ?? meta.url, {
        dispatcher: getSecureDispatcher(meta.options.skipTlsVerification),
        redirect: "follow",
        headers: meta.options.headers,
        signal: meta.abort.asSignal(),
      });

      const buf = Buffer.from(await x.arrayBuffer());
      let text = buf.toString("utf8");
      const charset = (text.match(
        /<meta\b[^>]*charset\s*=\s*["']?([^"'\s\/>]+)/i,
      ) ?? [])[1];
      try {
        if (charset) {
          text = new TextDecoder(charset.trim()).decode(buf);
        }
      } catch (error) {
        meta.logger.warn("Failed to re-parse with correct charset", {
          charset,
          error,
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
  }

  await specialtyScrapeCheck(
    meta.logger.child({ method: "scrapeURLWithFetch/specialtyScrapeCheck" }),
    Object.fromEntries(response.headers as any),
  );

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
