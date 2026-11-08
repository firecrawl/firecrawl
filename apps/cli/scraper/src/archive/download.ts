/* eslint-disable no-await-in-loop -- redirects, retry backoff and streaming depend on previous results. */
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { setTimeout as sleep } from "node:timers/promises";
import type { MediaRef } from "./discovery.js";
import { httpUrl } from "./discovery.js";
import { assetPath } from "./paths.js";

export interface MediaResult extends MediaRef {
  status: "downloaded" | "skipped" | "failed";
  path?: string;
  bytes?: number;
  reason?: string;
}

export interface MediaTransferProgress {
  phase: "requesting" | "downloading" | "retrying";
  attempt: number;
  bytes: number;
  totalBytes?: number;
  retryAfterMs?: number;
}

export interface DownloadOptions {
  root: string;
  maxBytes: number;
  headers: (url: string) => Promise<Record<string, string>>;
  signal?: AbortSignal | undefined;
  timeoutMs?: number;
  onProgress?: (progress: MediaTransferProgress) => void;
}

class TooLarge extends Error {}

export function retryDelay(value: string | null | undefined, fallback = 1000): number {
  if (!value) return fallback;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : fallback;
}

// Audio-only files are commonly served with Ogg or MP4/WebM container types.
const AUDIO_CONTAINERS = new Set(["application/ogg", "video/mp4", "video/webm", "video/ogg"]);

function acceptsType(kind: MediaResult["kind"], type: string): boolean {
  return type.startsWith(`${kind}/`) || (kind === "audio" && AUDIO_CONTAINERS.has(type));
}

export async function downloadMedia(ref: MediaRef, opts: DownloadOptions): Promise<MediaResult> {
  if (ref.skipReason || ref.kind === "embed")
    return { ...ref, status: "skipped", reason: ref.skipReason ?? "Embedded player" };
  let temporary: string | undefined;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      opts.signal?.throwIfAborted();
      opts.onProgress?.({ phase: "requesting", attempt: attempt + 1, bytes: 0 });
      const signal = AbortSignal.any([
        AbortSignal.timeout(opts.timeoutMs ?? 30_000),
        ...(opts.signal ? [opts.signal] : []),
      ]);
      let url = ref.url;
      let response: Response | undefined;
      for (let redirect = 0; redirect <= 5; redirect++) {
        response = await fetch(url, {
          headers: await opts.headers(url),
          redirect: "manual",
          signal,
        });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const target = httpUrl(response.headers.get("location") ?? "", url);
        await response.body?.cancel();
        if (!target || redirect === 5) throw new Error("Invalid or excessive media redirects");
        url = target;
      }
      if (!response) throw new Error("No media response");
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        const delay = retryDelay(response.headers.get("retry-after"), 500 * 2 ** attempt);
        await response.body?.cancel();
        opts.onProgress?.({
          phase: "retrying",
          attempt: attempt + 1,
          bytes: 0,
          retryAfterMs: delay,
        });
        await sleep(delay, undefined, { signal: opts.signal });
        continue;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(`Media returned HTTP ${response.status}`);
      }
      const type =
        (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
      const streaming = /(?:mpegurl|dash\+xml)/.test(type);
      if (streaming) {
        await response.body.cancel();
        return { ...ref, status: "skipped", reason: "Streaming manifest; direct files only" };
      }
      if (type && type !== "application/octet-stream" && !acceptsType(ref.kind, type)) {
        await response.body.cancel();
        throw new Error(`Expected ${ref.kind} content, received ${type}`);
      }
      if (Number(response.headers.get("content-length")) > opts.maxBytes) {
        await response.body.cancel();
        throw new TooLarge("Exceeds media size limit");
      }
      const rel = assetPath(ref.url, ref.kind, type);
      const target = join(opts.root, rel);
      await mkdir(dirname(target), { recursive: true });
      temporary = `${target}.${randomUUID()}.part`;
      let bytes = 0;
      const length = Number(response.headers.get("content-length"));
      // fetch decodes compressed bodies; their wire Content-Length is not a byte total.
      const total =
        length > 0 && Number.isFinite(length) && !response.headers.get("content-encoding")
          ? { totalBytes: length }
          : {};
      opts.onProgress?.({ phase: "downloading", attempt: attempt + 1, bytes, ...total });
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          opts.onProgress?.({ phase: "downloading", attempt: attempt + 1, bytes, ...total });
          callback(bytes > opts.maxBytes ? new TooLarge("Exceeds media size limit") : null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(response.body as ReadableStream),
        counter,
        createWriteStream(temporary, { flags: "wx" }),
        { signal },
      );
      await rename(temporary, target);
      temporary = undefined;
      return { ...ref, status: "downloaded", path: rel, bytes };
    }
    throw new Error("Media retries exhausted");
  } catch (err) {
    opts.signal?.throwIfAborted();
    return {
      ...ref,
      status: err instanceof TooLarge ? "skipped" : "failed",
      reason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (temporary) await rm(temporary, { force: true });
  }
}
