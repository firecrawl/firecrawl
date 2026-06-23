import {
  DNSResolutionError,
  SiteError,
  SSLError,
} from "../scraper/scrapeURL/error";
import * as undici from "undici";
import { getSecureDispatcher } from "./safe-fetch";

const mapUndiciError = (url: string, skipTlsVerification: boolean, e: any) => {
  const code = e?.code ?? e?.cause?.code ?? e?.errno ?? e?.name;
  if (e?.name === "AbortError") {
    return e;
  }

  switch (code) {
    case "UND_ERR_CONNECT_TIMEOUT":
    case "UND_ERR_HEADERS_TIMEOUT":
    case "UND_ERR_BODY_TIMEOUT":
    case "ETIMEDOUT":
      return new SiteError("ERR_TIMED_OUT");

    case "ECONNREFUSED":
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return new SiteError("ERR_CONNECT_REFUSED");

    case "ENOTFOUND":
    case "EAI_AGAIN": {
      let hostname = url;
      try {
        hostname = new URL(url).hostname;
      } catch {}
      return new DNSResolutionError(hostname);
    }

    case "ECONNRESET":
    case "EPIPE":
    case "ECONNABORTED":
      return new SiteError("ERR_CONNECTION_RESET");

    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "ERR_TLS_CERT_ALTNAME_INVALID":
      return new SSLError(skipTlsVerification);

    default:
      return e;
  }
};

export async function fetchFileToBuffer(
  url: string,
  skipTlsVerification: boolean = false,
  init?: undici.RequestInit,
): Promise<{
  response: undici.Response;
  buffer: Buffer;
}> {
  try {
    const response = await undici.fetch(url, {
      ...init,
      redirect: "follow",
      dispatcher: getSecureDispatcher(skipTlsVerification),
    });
    return {
      response,
      buffer: Buffer.from(await response.arrayBuffer()),
    };
  } catch (e) {
    throw mapUndiciError(url, skipTlsVerification, e);
  }
}
