import path from "path";
import os from "os";
import { createWriteStream, promises as fs } from "node:fs";
import { EngineError } from "../../error";
import { Writable } from "stream";
import { v4 as uuid } from "uuid";
import * as undici from "undici";
import { getSecureDispatcher } from "./safeFetch";

export async function fetchFileToBuffer(
  url: string,
  init?: undici.RequestInit,
): Promise<{
  response: undici.Response;
  buffer: Buffer;
}> {
  const response = await undici.fetch(url, {
    ...init,
    redirect: "follow",
    dispatcher: getSecureDispatcher(),
  });
  return {
    response,
    buffer: Buffer.from(await response.arrayBuffer()),
  };
}

export async function downloadFile(
  id: string,
  url: string,
  init?: undici.RequestInit,
): Promise<{
  response: undici.Response;
  tempFilePath: string;
  cleanup: () => Promise<void>;
}> {
  const tempFilePath = path.join(os.tmpdir(), `tempFile-${id}--${uuid()}`);
  const tempFileWrite = createWriteStream(tempFilePath);

  const cleanup = async () => {
    try {
      await fs.unlink(tempFilePath);
    } catch (error) {
      // Ignore errors if file doesn't exist or can't be deleted
    }
  };

  try {
    // TODO: maybe we could use tlsclient for this? for proxying
    const response = await undici.fetch(url, {
      ...init,
      redirect: "follow",
      dispatcher: getSecureDispatcher(),
    });

    // This should never happen in the current state of JS/Undici (2024), but let's check anyways.
    if (response.body === null) {
      throw new EngineError("Response body was null", { cause: { response } });
    }

    try {
      await response.body
        .pipeTo(Writable.toWeb(tempFileWrite), {
          signal: init?.signal || undefined,
        })
        .catch(error => {
          throw new EngineError("Failed to write to temp file", {
            cause: { error },
          });
        });
    } finally {
      tempFileWrite.close();
    }

    return {
      response,
      tempFilePath,
      cleanup,
    };
  } catch (error) {
    // If anything fails, cleanup the temp file immediately
    await cleanup();
    throw error;
  }
}
