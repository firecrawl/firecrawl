import path from "path";
import os from "os";
import { createWriteStream, promises as fs } from "node:fs";
import {
  AddFeatureError,
  DNSResolutionError,
  EngineError,
  SiteError,
  SSLError,
  UnsupportedFileError,
} from "../../error";
import { Writable } from "stream";
import { TransformStream as NodeTransformStream } from "node:stream/web";
import { v7 as uuid } from "uuid";
import * as undici from "undici";
import { getSecureDispatcher } from "./safeFetch";
import { logger } from "../../../../lib/logger";

/**
 * Matches undici ProxyAgent tunnel failures: the proxy's CONNECT response was
 * not 200 (502, 407, ...). undici emits `RequestAbortedError` (code
 * UND_ERR_ABORTED) with the message "Proxy response (NNN) !== 200 when HTTP
 * Tunneling" — see undici's lib/dispatcher/proxy-agent.js.
 */
const PROXY_TUNNEL_FAILURE_MESSAGE =
  /Proxy response \(\d+\) !== 200 when HTTP Tunneling/;

/**
 * Detects a proxy tunneling failure anywhere in an error's cause chain.
 *
 * undici wraps these several levels deep —
 * TypeError("fetch failed") → DOMException("Request was cancelled.") →
 * RequestAbortedError("Proxy response (502) !== 200 when HTTP Tunneling") —
 * so, unlike mapUndiciError, we walk the whole chain. Callers use this to
 * retry the download through a different transport (e.g. the browser engine's
 * own proxy infra) instead of failing the scrape.
 */
function isProxyFetchFailure(error: unknown): boolean {
  let current: unknown = error;
  // Bounded walk with a visited guard: cause chains are short in practice,
  // but a malformed/cyclic chain must never spin or crash the scrape.
  const visited = new Set<unknown>();
  while (
    typeof current === "object" &&
    current !== null &&
    !visited.has(current)
  ) {
    visited.add(current);
    const message = (current as { message?: unknown }).message;
    if (
      typeof message === "string" &&
      PROXY_TUNNEL_FAILURE_MESSAGE.test(message)
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Wraps a file engine's direct undici download so a proxy tunneling failure
 * converts into an engine-level error that the scrapeURL retry loop treats
 * exactly like the antibot case: clear the file flag and re-run the waterfall,
 * letting the browser engine fetch the file through fire-engine's own proxy
 * infrastructure instead of ours (see PDFFetchProxyError /
 * DocumentFetchProxyError).
 *
 * Converts when the engine is the flag-mandated handler for the file type
 * and no usable prefetch exists. The retry loop distinguishes the two empty
 * prefetch states: `undefined` ("browser never attempted") triggers the
 * browser fallback; `null` ("browser attempted, delivered no file") fails
 * fast with this error rather than burning another prefetch round trip.
 * A real prefetch object never reaches the direct download at all.
 */
export async function fetchFileGuardingProxyFailure<T>(
  opts: {
    /** meta's prefetch state for this file type; undefined = not attempted,
     *  null = attempted and came back empty, object = use the file. */
    prefetch: unknown;
    /** Whether the engine is the flag-mandated handler for this file type
     *  (feature flag, or a scalar forceEngine pinning this engine). */
    flagMandated: boolean;
    /** Error that triggers the browser-engine fallback in the retry loop. */
    makeError: () => Error;
  },
  fetch: () => Promise<T>,
): Promise<T> {
  try {
    return await fetch();
  } catch (error) {
    if (
      opts.prefetch == null &&
      opts.flagMandated &&
      isProxyFetchFailure(error)
    ) {
      throw opts.makeError();
    }
    throw error;
  }
}

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

function createSizeLimiter(maxSize: number) {
  let bytesRead = 0;
  return new NodeTransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytesRead += chunk.byteLength;
      if (bytesRead > maxSize) {
        controller.error(new UnsupportedFileError("File exceeds size limit"));
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

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

export async function downloadFile(
  id: string,
  url: string,
  skipTlsVerification: boolean = false,
  init?: undici.RequestInit,
  maxSize?: number,
): Promise<{
  response: undici.Response;
  tempFilePath: string;
}> {
  const tempFilePath = path.join(os.tmpdir(), `tempFile-${id}--${uuid()}`);
  const tempFileWrite = createWriteStream(tempFilePath);
  let shouldCleanup = false;

  // TODO: maybe we could use tlsclient for this? for proxying
  try {
    const response = await undici.fetch(url, {
      ...init,
      redirect: "follow",
      dispatcher: getSecureDispatcher(skipTlsVerification),
    });

    if (maxSize !== undefined) {
      checkContentLength(response, maxSize);
    }

    // This should never happen in the current state of JS/Undici (2024), but let's check anyways.
    if (response.body === null) {
      throw new EngineError("Response body was null", { cause: { response } });
    }

    const body =
      maxSize !== undefined
        ? response.body.pipeThrough(createSizeLimiter(maxSize))
        : response.body;

    await body
      .pipeTo(Writable.toWeb(tempFileWrite), {
        signal: init?.signal || undefined,
      })
      .catch(error => {
        if (error instanceof UnsupportedFileError) throw error;
        throw new EngineError("Failed to write to temp file", {
          cause: { error },
        });
      });

    return {
      response,
      tempFilePath,
    };
  } catch (e) {
    shouldCleanup = true;
    if (e instanceof UnsupportedFileError) throw e;
    throw mapUndiciError(url, skipTlsVerification, e);
  } finally {
    tempFileWrite.close();
    if (shouldCleanup) {
      try {
        await fs.unlink(tempFilePath);
      } catch (cleanupError: any) {
        logger.warn("Failed to clean up temporary file", {
          error: cleanupError,
          tempFilePath,
        });
      }
    }
  }
}
