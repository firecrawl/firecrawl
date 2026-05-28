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
