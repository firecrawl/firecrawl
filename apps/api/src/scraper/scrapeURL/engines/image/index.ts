import { Meta } from "../..";
import { EngineScrapeResult } from "..";
import { fetchFileToBuffer } from "../utils/downloadFile";
import { EngineUnsuccessfulError, UnsupportedFileError } from "../../error";
import { readFile, stat, unlink } from "node:fs/promises";
import { useFireEngine } from "../fire-engine/available";
import { scrapePDFWithFirePDF } from "../pdf/firePDF";
import { FIRE_PDF_INLINE_HARD_MAX_FILE_SIZE } from "../pdf/types";
import {
  imageExtensionFromUrlPath,
  sniffImageContentType,
} from "../../../../lib/image-formats";

/**
 * Raster images are OCR'd as one-page scanned documents through the FirePDF
 * pipeline. FirePDF opens the bytes as a single-page image document
 * (PNG/JPEG/JPEG 2000/TIFF/GIF/BMP), finds no text layer, and runs the same
 * layout + OCR path a scanned PDF page takes.
 *
 * OCR is on by default and opt-out per request (a `parsers` list without
 * `image`; a parse upload of an image always counts), and rolled out per
 * team (imageOcr flag); both are folded into `meta.imageOcrEnabled`. The pdf
 * parser's options (mode, maxPages, pages, blocks, pageMarkers) are not
 * consulted: an image has no text layer to fall back on, so every admitted
 * image is OCR'd. A caller who wants the bytes instead uses the `rawBase64`
 * format, which the browser engine serves without ever reaching this engine.
 */

// Images reach fire-pdf inline (base64 JSON) and have no by-reference
// route, so the ceiling is the inline hard max shared with PDFs: above it
// the POST is a guaranteed 413. fire-engine applies its own download cap
// upstream, but this engine cannot rely on it (large images have been
// handed off inline), so the prefetch is re-checked here and the direct
// download path uses the same ceiling.
const IMAGE_MAX_FILE_SIZE = FIRE_PDF_INLINE_HARD_MAX_FILE_SIZE;

export async function scrapeImage(meta: Meta): Promise<EngineScrapeResult> {
  // A browser handoff's temp file must be removed on every exit, including
  // the gates below, so the cleanup scope opens before anything can throw.
  let tempFilePath: string | null = meta.imagePrefetch?.filePath ?? null;

  try {
    // With fire-engine available this engine never downloads files itself:
    // buildFallbackList routes image URLs through the browser engines and the
    // file arrives here via imagePrefetch (specialtyScrapeCheck). Reaching
    // this point without one means a cross-type handoff landed in another
    // prefetch slot (a .png URL serving a PDF) or the browser round trip
    // delivered no file; neither has a browser-retry remedy worth another
    // round trip for an image, so decline and let the waterfall continue.
    // Self-hosted deployments (no fire-engine) and explicit forceEngine pins
    // (parse uploads) take the direct path below.
    if (
      useFireEngine &&
      meta.internalOptions.forceEngine === undefined &&
      meta.imagePrefetch == null
    ) {
      throw new EngineUnsuccessfulError("image");
    }

    // Requests already identified as images (a browser handoff, the image
    // flag, a forceEngine pin, or an image-extension URL) resolve the
    // per-team gate up front. Anything else is a waterfall tail that has to
    // sniff its bytes first, so an ordinary failed page never pays for a
    // team lookup here.
    const knownImage =
      meta.imagePrefetch != null ||
      meta.featureFlags.has("image") ||
      meta.internalOptions.forceEngine === "image" ||
      imageExtensionFromUrlPath(
        new URL(meta.rewrittenUrl ?? meta.url).pathname,
      ) !== null;
    if (knownImage && !(await meta.imageOcrEnabled())) {
      // Opted out (parsers without image) or no team flag: the request gets
      // the unsupported-file error the URL path has always produced, whose
      // message names the parser.
      throw new UnsupportedFileError(
        meta.imagePrefetch?.contentType ?? "image",
      );
    }

    let buffer: Buffer;
    let url: string;
    let statusCode: number;
    let headerContentType: string | null;
    let proxyUsed: "basic" | "stealth";

    if (meta.imagePrefetch != null) {
      tempFilePath = meta.imagePrefetch.filePath;
      // Check the size before reading: a browser handoff can be far larger
      // than this engine accepts, and the file must not be materialized in
      // memory just to be rejected. (The direct download path below is
      // capped by fetchFileToBuffer itself.)
      const { size } = await stat(tempFilePath);
      if (size > IMAGE_MAX_FILE_SIZE) {
        throw new UnsupportedFileError("File exceeds size limit");
      }
      buffer = await readFile(tempFilePath);
      url = meta.imagePrefetch.url ?? meta.rewrittenUrl ?? meta.url;
      statusCode = meta.imagePrefetch.status;
      headerContentType = meta.imagePrefetch.contentType ?? null;
      proxyUsed = meta.imagePrefetch.proxyUsed;
    } else {
      const file = await fetchFileToBuffer(
        meta.rewrittenUrl ?? meta.url,
        meta.options.skipTlsVerification,
        {
          headers: meta.options.headers,
          signal: meta.abort.asSignal(),
        },
        IMAGE_MAX_FILE_SIZE,
      );
      buffer = file.buffer;
      url = file.response.url;
      statusCode = file.response.status;
      headerContentType = file.response.headers.get("content-type");
      proxyUsed = "basic";
    }

    // The bytes decide, not the header: FirePDF can only open what the magic
    // bytes say it is, and servers mislabel in both directions.
    const contentType = sniffImageContentType(buffer);
    if (contentType === null) {
      // On the direct download path an ordinary HTML page lands here
      // whenever this engine is merely the tail of the waterfall (no
      // "image" flag), so only fail loudly when an image was expected.
      if (meta.imagePrefetch == null && !meta.featureFlags.has("image")) {
        throw new EngineUnsuccessfulError("image");
      }
      throw new UnsupportedFileError(
        headerContentType ?? "unknown image format",
      );
    }

    // A tail request whose bytes turned out to be an image: consult the gate
    // now that the lookup is warranted.
    if (!knownImage && !(await meta.imageOcrEnabled())) {
      throw new UnsupportedFileError(contentType);
    }

    const base64Content = buffer.toString("base64");

    let result: Awaited<ReturnType<typeof scrapePDFWithFirePDF>>;
    try {
      result = await scrapePDFWithFirePDF(
        {
          ...meta,
          logger: meta.logger.child({
            method: "scrapeImage/scrapePDFWithFirePDF",
          }),
        },
        base64Content,
        undefined,
        1,
        "ocr",
      );
    } catch (error) {
      // FirePDF answers 400 when it cannot open the bytes (truncated or
      // corrupt image). That is a property of the file, not an outage, so
      // surface it as the same clean error a non-image binary gets instead
      // of letting the waterfall exhaust itself.
      if (isFirePdfRejection(error)) {
        meta.logger.warn("FirePDF rejected image", { error, contentType });
        throw new UnsupportedFileError(contentType);
      }
      throw error;
    }

    return {
      url,
      statusCode,
      html: result.html,
      markdown: result.markdown,
      contentType,
      proxyUsed,
    };
  } finally {
    if (tempFilePath) {
      try {
        await unlink(tempFilePath);
      } catch (error) {
        meta.logger?.warn("Failed to clean up temporary image file", {
          error,
          tempFilePath,
        });
      }
    }
  }
}

// robustFetch wraps a non-2xx as Error("Request sent failure status",
// { cause: { response: { status, body } } }). fire-pdf answers 400 with
// "Invalid or corrupt PDF" when it cannot open the bytes; any other 400 is a
// request-side problem and keeps propagating so the waterfall can retry.
const FIRE_PDF_UNOPENABLE = /invalid or corrupt/i;

function isFirePdfRejection(error: unknown): boolean {
  const response = (
    error as { cause?: { response?: { status?: unknown; body?: unknown } } }
  )?.cause?.response;
  if (response?.status !== 400) return false;
  const body = response.body;
  const text =
    typeof body === "string"
      ? body
      : typeof body === "object" &&
          body !== null &&
          typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : JSON.stringify(body ?? "");
  return FIRE_PDF_UNOPENABLE.test(text);
}

export function imageMaxReasonableTime(_meta: Meta): number {
  return 60000;
}
