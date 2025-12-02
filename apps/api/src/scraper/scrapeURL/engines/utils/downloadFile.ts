import path from "path";
import os from "os";
import { createWriteStream, promises as fs } from "node:fs";
import {
  AddFeatureError,
  DNSResolutionError,
  EngineError,
  SiteError,
  SSLError,
} from "../../error";
import { Writable } from "stream";
import { v4 as uuid } from "uuid";
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

export async function downloadFile(
  id: string,
  url: string,
  skipTlsVerification: boolean = false,
  init?: undici.RequestInit,
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

    // This should never happen in the current state of JS/Undici (2024), but let's check anyways.
    if (response.body === null) {
      throw new EngineError("Response body was null", { cause: { response } });
    }

    await response.body
      .pipeTo(Writable.toWeb(tempFileWrite), {
        signal: init?.signal || undefined,
      })
      .catch(error => {
        throw new EngineError("Failed to write to temp file", {
          cause: { error },
        });
      });

    return {
      response,
      tempFilePath,
    };
  } catch (e) {
    // Mark for cleanup on error (caller handles cleanup on success)
    shouldCleanup = true;
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
