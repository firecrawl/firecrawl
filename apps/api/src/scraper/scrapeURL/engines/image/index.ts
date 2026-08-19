import { Meta } from "../..";
import { EngineScrapeResult } from "..";
import { fetchFileToBuffer } from "../utils/downloadFile";
import { readFile } from "node:fs/promises";
import { EngineUnsuccessfulError } from "../../error";

// Base64 inflates the payload by ~33%, so cap the download to bound memory and
// response size. Kept in line with the PDF download cap for consistency.
const IMAGE_DOWNLOAD_MAX_FILE_SIZE = 50 * 1024 * 1024;

export function imageMaxReasonableTime(_meta: Meta): number {
  return 60000;
}

function toDataUri(contentType: string | undefined, buffer: Buffer): string {
  const mime = contentType?.split(";")[0]?.trim() || "application/octet-stream";
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

/**
 * Returns the raw bytes of an image URL as a base64 data URI. Selected only
 * when the `image` feature flag is active, which is added when the `rawBase64`
 * format is requested and the scraped resource is an image. Mirrors the PDF
 * engine's "no parse" path: read the prefetched bytes if an engine already
 * fetched them, otherwise download directly.
 */
export async function scrapeImage(meta: Meta): Promise<EngineScrapeResult> {
  if (meta.imagePrefetch !== undefined && meta.imagePrefetch !== null) {
    const buffer = await readFile(meta.imagePrefetch.filePath);
    const contentType = meta.imagePrefetch.contentType;
    return {
      url: meta.imagePrefetch.url ?? meta.rewrittenUrl ?? meta.url,
      statusCode: meta.imagePrefetch.status,

      html: "",
      rawBase64: toDataUri(contentType, buffer),

      contentType,
      proxyUsed: meta.imagePrefetch.proxyUsed,
    };
  }

  const file = await fetchFileToBuffer(
    meta.rewrittenUrl ?? meta.url,
    meta.options.skipTlsVerification,
    {
      headers: meta.options.headers,
      signal: meta.abort.asSignal(),
    },
    IMAGE_DOWNLOAD_MAX_FILE_SIZE,
  );

  const contentType = file.response.headers.get("content-type") ?? undefined;

  // Only serve genuine image content as rawBase64. A non-image response here
  // means the URL wasn't actually an image (e.g. content-type changed between
  // detection and download); let the waterfall report failure rather than
  // return arbitrary bytes.
  if (!contentType || !contentType.startsWith("image/")) {
    throw new EngineUnsuccessfulError("image");
  }

  return {
    url: file.response.url,
    statusCode: file.response.status,

    html: "",
    rawBase64: toDataUri(contentType, file.buffer),

    contentType,
    proxyUsed: "basic",
  };
}
