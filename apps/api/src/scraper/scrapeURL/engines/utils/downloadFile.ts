import {
  DNSResolutionError,
  SiteError,
  SSLError,
  UnsupportedFileError,
} from "../../error";
import * as undici from "undici";
import { getSecureDispatcher } from "./safeFetch";

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

function checkContentLength(response: undici.Response, maxSize: number) {
  const header = response.headers.get("content-length");
  if (header === null) return;
  const declared = Number(header);
  if (Number.isFinite(declared) && declared > maxSize) {
    throw new UnsupportedFileError("File exceeds size limit");
  }
}

export async function fetchFileToBuffer(
  url: string,
  skipTlsVerification: boolean = false,
  init?: undici.RequestInit,
  maxSize?: number,
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
    if (maxSize !== undefined) {
      checkContentLength(response, maxSize);
    }
    if (maxSize === undefined || response.body === null) {
      return {
        response,
        buffer: Buffer.from(await response.arrayBuffer()),
      };
    }
    const chunks: Uint8Array[] = [];
    let bytesRead = 0;
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxSize) {
        await reader.cancel().catch(() => {});
        throw new UnsupportedFileError("File exceeds size limit");
      }
      chunks.push(value);
    }
    return {
      response,
      buffer: Buffer.concat(chunks),
    };
  } catch (e) {
    if (e instanceof UnsupportedFileError) throw e;
    throw mapUndiciError(url, skipTlsVerification, e);
  }
}
