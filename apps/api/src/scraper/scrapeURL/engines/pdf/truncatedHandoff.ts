import { open, unlink } from "node:fs/promises";
import type { Meta } from "../..";
import { AbortManagerThrownError } from "../../lib/abortManager";
import { downloadFile } from "../utils/downloadFile";
import { isPdfBuffer, PDF_SNIFF_WINDOW } from "./pdfUtils";

type PdfPrefetch = NonNullable<Meta["pdfPrefetch"]>;

// The PDF spec puts the end-of-file marker in the last 1024 bytes; real
// files sometimes carry trailing junk after it, so look a little further.
const EOF_SEARCH_BYTES = 4096;

/**
 * The body length a response declared, when it describes the bytes as
 * delivered: a Content-Length under a content encoding counts the encoded
 * stream, not the decoded file.
 */
export function declaredContentLength(
  headers: Record<string, string> | undefined,
): number | undefined {
  if (!headers) return undefined;
  const header = (name: string) =>
    Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1];
  const encoding = header("content-encoding")?.trim().toLowerCase();
  if (encoding && encoding !== "identity") return undefined;
  const raw = header("content-length")?.trim();
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const length = Number(raw);
  return Number.isSafeInteger(length) && length > 0 ? length : undefined;
}

/**
 * Whether a downloaded PDF stops short of its end: fewer bytes than the
 * response declared, or a file that does not end with an end-of-file marker.
 * Only whitespace may follow the last marker: an incremental update cut off
 * partway leaves the previous revision's marker in the tail, followed by the
 * new revision's partial objects.
 */
export async function isTruncatedPdf(
  filePath: string,
  contentLength?: number,
): Promise<boolean> {
  const fh = await open(filePath, "r");
  try {
    const { size } = await fh.stat();
    if (contentLength !== undefined && size < contentLength) return true;
    const length = Math.min(size, EOF_SEARCH_BYTES);
    const tail = Buffer.alloc(length);
    await fh.read(tail, 0, length, size - length);
    const marker = tail.lastIndexOf("%%EOF");
    if (marker === -1) return true;
    return !/^[\s\0]*$/.test(tail.subarray(marker + 5).toString("latin1"));
  } finally {
    await fh.close();
  }
}

async function readRange(
  filePath: string,
  position: number,
  length: number,
): Promise<Buffer> {
  const fh = await open(filePath, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, position);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

function readHead(filePath: string): Promise<Buffer> {
  return readRange(filePath, 0, PDF_SNIFF_WINDOW);
}

// How much of the handoff a re-downloaded copy must reproduce byte for byte:
// its start and the bytes just before the cut.
const SAME_FILE_HEAD_BYTES = 64 * 1024;
const SAME_FILE_TAIL_BYTES = 4 * 1024;

/**
 * Whether `copy` starts with the same bytes as `handoff`: the handoff's first
 * 64 KB and its last 4 KB must appear at the same offsets in the copy. A
 * different file — another language or region variant, a page served without
 * the session's cookies, an A/B variant — fails this.
 */
export async function startsWithSameBytes(
  handoff: string,
  copy: string,
): Promise<boolean> {
  const handoffBytes = await fileSize(handoff);
  if ((await fileSize(copy)) < handoffBytes) return false;
  const headLength = Math.min(handoffBytes, SAME_FILE_HEAD_BYTES);
  const tailStart = Math.max(0, handoffBytes - SAME_FILE_TAIL_BYTES);
  for (const [position, length] of [
    [0, headLength],
    [tailStart, handoffBytes - tailStart],
  ]) {
    const [a, b] = await Promise.all([
      readRange(handoff, position, length),
      readRange(copy, position, length),
    ]);
    if (!a.equals(b)) return false;
  }
  return true;
}

/**
 * Why the file must not be downloaded again outside the browser engine: the
 * request asked for a location or a non-basic proxy, or the handoff itself
 * came through the stealth proxy. A direct download would leave that network
 * path and could reach a different (or blocked) copy of the file.
 */
function networkSetupRequiresBrowser(meta: Meta, prefetch: PdfPrefetch) {
  const proxy = meta.options.proxy;
  return (
    meta.options.location !== undefined ||
    (proxy !== undefined && proxy !== "basic" && proxy !== "auto") ||
    prefetch.proxyUsed !== "basic" ||
    meta.featureFlags.has("stealthProxy")
  );
}

async function fileSize(filePath: string): Promise<number> {
  const fh = await open(filePath, "r");
  try {
    return (await fh.stat()).size;
  } finally {
    await fh.close();
  }
}

async function removeQuietly(filePath: string): Promise<void> {
  await unlink(filePath).catch(() => {});
}

/**
 * A browser handoff can deliver only the first part of a PDF: the capture
 * ends when the response stream does, even when the connection closed
 * before the whole body arrived. Parsing such a prefix finds no pages, or
 * silently loses every page past the cut. When the handoff looks cut off,
 * download the file again directly — once, and only when the request did
 * not ask for a location or a non-basic proxy — and use that copy if it
 * continues the handoff byte for byte and is a complete PDF (or at least a
 * longer one). Anything else keeps the handoff as it was.
 */
export async function completeTruncatedHandoff(
  meta: Meta,
  prefetch: PdfPrefetch,
  maxSize: number,
  download: typeof downloadFile = downloadFile,
): Promise<PdfPrefetch> {
  if (!prefetch.handoff || prefetch.gcsReference) return prefetch;
  const { contentLength } = prefetch.handoff;
  if (
    !isPdfBuffer(await readHead(prefetch.filePath)) ||
    !(await isTruncatedPdf(prefetch.filePath, contentLength))
  ) {
    return prefetch;
  }

  const handoffBytes = await fileSize(prefetch.filePath);
  const logger = meta.logger.child({
    method: "scrapePDF/completeTruncatedHandoff",
  });
  const report = (outcome: string, extra: Record<string, unknown> = {}) =>
    logger.warn("PDF handoff looks truncated", {
      event: "pdf_handoff_truncated",
      outcome,
      handoff_bytes: handoffBytes,
      declared_bytes: contentLength,
      scrape_id: meta.id,
      ...extra,
    });

  if (networkSetupRequiresBrowser(meta, prefetch)) {
    report("skipped_proxy");
    return prefetch;
  }

  let refetched: Awaited<ReturnType<typeof downloadFile>>;
  try {
    refetched = await download(
      meta.id,
      prefetch.url ?? meta.rewrittenUrl ?? meta.url,
      meta.options.skipTlsVerification,
      { headers: meta.options.headers, signal: meta.abort.asSignal() },
      maxSize,
    );
  } catch (error) {
    if (error instanceof AbortManagerThrownError) throw error;
    meta.abort.throwIfAborted();
    report("refetch_failed", { error });
    return prefetch;
  }

  const refetchedPath = refetched.tempFilePath;
  const refetchedBytes = await fileSize(refetchedPath);
  const keepHandoff = async (outcome: string) => {
    report(outcome, { refetched_bytes: refetchedBytes });
    await removeQuietly(refetchedPath);
    return prefetch;
  };

  if (!refetched.response.ok) return keepHandoff("refetch_bad_status");
  if (!isPdfBuffer(await readHead(refetchedPath))) {
    return keepHandoff("refetch_not_pdf");
  }
  if (!(await startsWithSameBytes(prefetch.filePath, refetchedPath))) {
    return keepHandoff("refetch_mismatch");
  }
  const complete = !(await isTruncatedPdf(
    refetchedPath,
    declaredContentLength(
      Object.fromEntries(refetched.response.headers.entries()),
    ),
  ));
  if (!complete && refetchedBytes <= handoffBytes) {
    return keepHandoff("refetch_incomplete");
  }

  report(complete ? "recovered" : "recovered_longer", {
    refetched_bytes: refetchedBytes,
  });
  await removeQuietly(prefetch.filePath);
  return {
    filePath: refetchedPath,
    url: refetched.response.url || prefetch.url,
    status: refetched.response.status,
    proxyUsed: "basic",
    contentType: prefetch.contentType,
  };
}
