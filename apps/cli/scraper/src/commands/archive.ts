/* eslint-disable no-await-in-loop -- crawling, rate limits and per-run deduplication are sequential. */
import { basename, extname, join, relative } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  discover,
  httpUrl,
  isPageUrl,
  mergeCaptured,
  type CapturedMedia,
} from "../archive/discovery.js";
import { downloadMedia, retryDelay, type MediaResult } from "../archive/download.js";
import { TextReporter, type ArchiveReporter } from "../archive/reporter.js";
import { ensureApiReady } from "../archive/local-api.js";
import { createRun, pagePath } from "../archive/paths.js";
import {
  saveManifest,
  savePage,
  type Manifest,
  type PageResult,
  type TranscriptEntry,
} from "../archive/storage.js";
import type { Config } from "../config.js";
import { createEnginePool, type Engine, type EngineName } from "../engines/index.js";
import type { ScrapeResponseData } from "../formats/types.js";
import { TranscribeQueue, type TranscribeRunner } from "../transcribe/queue.js";
import { assertWhisperReady } from "../transcribe/setup.js";
import type { TranscribeSettings } from "../transcribe/transcribe.js";
import { buildRequest } from "./scrape.js";

export const MEDIA_KINDS = ["image", "video", "audio"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/** Parse a comma-separated `--media` value such as "audio,video". */
export function parseMediaKinds(value: string): MediaKind[] {
  const kinds = value
    .split(",")
    .map((kind) => kind.trim().toLowerCase())
    .filter(Boolean);
  const invalid = kinds.filter((kind) => !(MEDIA_KINDS as readonly string[]).includes(kind));
  if (invalid.length > 0 || kinds.length === 0)
    throw new Error(`--media expects a list of ${MEDIA_KINDS.join(", ")}; got "${value}"`);
  return [...new Set(kinds as MediaKind[])];
}

export interface ArchiveOptions {
  url: string;
  config: Config;
  profileName: string;
  engineName: EngineName;
  cdpUrlOverride: string | undefined;
  out: string | undefined;
  limit: number;
  maxMediaMb: number;
  delayMs: number;
  /** CDP only: click play controls so on-demand audio/video is requested. */
  playMedia?: boolean;
  /** Media kinds to download; defaults to all. Embedded players count as video. */
  media?: MediaKind[] | undefined;
  /** Transcribe downloaded audio and video while the crawl continues. */
  transcribe?: ArchiveTranscribeOptions | undefined;
  /** Progress output; defaults to text lines on stderr. */
  reporter?: ArchiveReporter | undefined;
  signal?: AbortSignal;
}

export interface ArchiveTranscribeOptions {
  workers: number;
  settings: TranscribeSettings;
  /** Replaces whisper for tests. */
  runner?: TranscribeRunner;
}

const TRANSCRIBABLE = new Set<MediaResult["kind"]>(["audio", "video"]);

export function mediaHeaders(
  engine: Engine,
  configured: Record<string, string> | undefined,
  sourceUrl: string,
  pageUrl: string,
): (url: string) => Promise<Record<string, string>> {
  return async (url) => {
    const target = new URL(url);
    const page = new URL(pageUrl);
    const headers = new Headers(await engine.downloadHeaders?.(url));
    if (target.origin === new URL(sourceUrl).origin) {
      for (const [key, value] of Object.entries(configured ?? {})) {
        if (!["host", "content-length", "connection"].includes(key.toLowerCase()))
          headers.set(key, value);
      }
    }
    if (!(page.protocol === "https:" && target.protocol === "http:")) {
      headers.set("Referer", target.origin === page.origin ? page.href : `${page.origin}/`);
    }
    return Object.fromEntries(headers);
  };
}

export async function runArchive(
  opts: ArchiveOptions,
): Promise<{ root: string; manifest: Manifest }> {
  const sourceUrl = httpUrl(opts.url);
  if (!sourceUrl) throw new Error("Provide a valid HTTP(S) URL without embedded credentials");
  if (
    !Number.isSafeInteger(opts.limit) ||
    opts.limit < 1 ||
    !Number.isFinite(opts.maxMediaMb) ||
    opts.maxMediaMb <= 0 ||
    opts.maxMediaMb * 1_000_000 > Number.MAX_SAFE_INTEGER ||
    !Number.isSafeInteger(opts.delayMs) ||
    opts.delayMs < 0
  )
    throw new Error("Invalid archive limits");
  if (opts.out === "-") throw new Error("Archive output must be a directory, not stdout");
  if (opts.playMedia && opts.engineName !== "cdp")
    throw new Error("--play-media requires the CDP engine");
  if (opts.transcribe && !opts.transcribe.runner)
    assertWhisperReady(opts.transcribe.settings.whisper);
  const reporter = opts.reporter ?? new TextReporter();

  const wanted = opts.media ?? [...MEDIA_KINDS];
  const selected = (kind: MediaResult["kind"]): boolean =>
    wanted.includes(kind === "embed" ? "video" : kind);

  const pool = createEnginePool(opts.config, opts.cdpUrlOverride, { playMedia: opts.playMedia });
  try {
    const engine = pool.get(opts.engineName);
    if (opts.engineName === "api")
      await ensureApiReady(opts.config.apiUrl, opts.signal, (event) => reporter.setup(event));
    await engine.prepare?.();
    opts.signal?.throwIfAborted();
    const root = await createRun(sourceUrl, opts.out);
    reporter.started(root);
    const manifest: Manifest = {
      sourceUrl,
      engine: opts.engineName,
      startedAt: new Date().toISOString(),
      status: "running",
      settings: {
        limit: opts.limit,
        maxMediaMb: opts.maxMediaMb,
        delayMs: opts.delayMs,
        playMedia: opts.playMedia ?? false,
        media: wanted,
        ...(opts.transcribe
          ? {
              transcribe: {
                workers: opts.transcribe.workers,
                language: opts.transcribe.settings.language,
                model: basename(opts.transcribe.settings.whisper.model),
              },
            }
          : {}),
      },
      limitReached: false,
      pages: [],
      assets: [],
      ...(opts.transcribe ? { transcripts: [] } : {}),
    };
    const transcripts = new Map<string, TranscriptEntry>();
    const transcriber = opts.transcribe
      ? new TranscribeQueue({
          workers: opts.transcribe.workers,
          settings: opts.transcribe.settings,
          signal: opts.signal,
          onEvent: (event) => reporter.transcription(event),
          ...(opts.transcribe.runner ? { runner: opts.transcribe.runner } : {}),
        })
      : undefined;
    // Queue a fresh audio/video download; the crawl continues while workers transcribe.
    const transcribe = (asset: MediaResult): void => {
      if (!transcriber || asset.status !== "downloaded" || !asset.path) return;
      if (!TRANSCRIBABLE.has(asset.kind) || transcripts.has(asset.path)) return;
      const entry: TranscriptEntry = { asset: asset.url, media: asset.path, status: "queued" };
      transcripts.set(asset.path, entry);
      const stem = basename(asset.path, extname(asset.path));
      void transcriber
        .add({
          input: join(root, asset.path),
          base: join(root, "transcripts", stem),
          label: stem,
        })
        .then((result) => {
          entry.status = result.status;
          entry.files = result.files?.map((file) => relative(root, file));
          entry.language = result.language;
          entry.durationSec = result.durationSec;
          entry.segments = result.segments;
          entry.reason = result.reason;
        });
    };
    const queue = [sourceUrl];
    const seen = new Set(queue);
    const finalUrls = new Set<string>();
    const assets = new Map<string, MediaResult>();
    let origin = new URL(sourceUrl).origin;
    let nextAt = 0;
    await saveManifest(root, manifest);
    try {
      // Visit links breadth-first until the queue is exhausted or --limit attempts
      // are reached (default 100). Failures/redirects count too; this is not a depth limit.
      for (let i = 0; i < queue.length && i < opts.limit; i++) {
        opts.signal?.throwIfAborted();
        await sleep(Math.max(0, nextAt - Date.now()), undefined, { signal: opts.signal });
        const url = queue[i]!;
        const result: PageResult = { url, path: pagePath(url), status: "failed" };
        let data: ScrapeResponseData = {};
        let links: string[] = [];
        const media: MediaResult[] = [];
        let backoff = 0;
        reporter.page(i + 1, opts.limit, url);
        try {
          const req = buildRequest(url, opts.config, opts.profileName, []);
          req.formats = [
            "markdown",
            "html",
            "rawHtml",
            "links",
            ...(opts.engineName === "cdp" ? ["screenshot"] : []),
          ];
          req.onlyMainContent = false;
          req.actions = undefined;
          data = await engine.scrape(req, opts.signal);
          const finalUrl = httpUrl(String(data.metadata?.["url"] ?? url)) ?? url;
          result.finalUrl = finalUrl;
          result.title = String(data.metadata?.["title"] ?? finalUrl);
          const status = Number(data.metadata?.["statusCode"] ?? 200);
          if (status === 429) backoff = retryDelay(String(data.metadata?.["retryAfter"] ?? ""));
          if (status >= 400) throw new Error(`Page returned HTTP ${status}`);
          // A seed redirect (e.g. apex to www) establishes the crawl's origin.
          if (i === 0) origin = new URL(finalUrl).origin;
          if (new URL(finalUrl).origin !== origin || !isPageUrl(finalUrl, origin)) {
            result.status = "skipped";
            result.reason = "Redirect outside crawl scope";
          } else if (finalUrls.has(finalUrl)) {
            result.status = "skipped";
            result.reason = "Duplicate redirect target";
          } else {
            finalUrls.add(finalUrl);
            const discovered = discover(data.rawHtml ?? data.html ?? "", finalUrl);
            const pageMedia = mergeCaptured(
              discovered.media,
              Array.isArray(data["mediaRequests"])
                ? (data["mediaRequests"] as CapturedMedia[])
                : undefined,
            );
            links = [
              ...new Set([
                ...discovered.links,
                ...(data.links ?? [])
                  .map((link) => httpUrl(link, finalUrl))
                  .filter((link): link is string => Boolean(link)),
              ]),
            ];
            for (const link of links) {
              if (isPageUrl(link, origin) && !seen.has(link) && !finalUrls.has(link)) {
                seen.add(link);
                queue.push(link);
              }
            }
            const headers = mediaHeaders(engine, req.headers, url, finalUrl);
            reporter.pageCaptured(pageMedia.length);
            try {
              for (const [index, ref] of pageMedia.entries()) {
                let asset = assets.get(ref.url);
                const reused = Boolean(asset && !(asset.kind === "embed" && ref.kind !== "embed"));
                reporter.mediaStarted(index + 1, pageMedia.length, ref.url, reused);
                if (!selected(ref.kind)) {
                  asset = { ...ref, status: "skipped", reason: "Media type not selected" };
                  assets.set(ref.url, asset);
                } else if (!asset || !reused) {
                  asset = await downloadMedia(ref, {
                    root,
                    maxBytes: opts.maxMediaMb * 1_000_000,
                    headers,
                    signal: opts.signal,
                    onProgress: (progress) => reporter.mediaProgress(progress),
                  });
                  assets.set(ref.url, asset);
                  transcribe(asset);
                }
                reporter.mediaFinished(asset, reused);
                media.push(asset);
              }
            } finally {
              reporter.mediaDone();
            }
            result.status = "saved";
          }
          if (typeof data["warning"] === "string") result.warning = data["warning"];
          else if (opts.engineName === "api")
            result.warning =
              "Screenshot not requested: self-hosted API engine support is unavailable";
        } catch (err) {
          result.status = "failed";
          result.reason = opts.signal?.aborted
            ? "Interrupted"
            : err instanceof Error
              ? err.message
              : String(err);
          reporter.pageFailed(url, result.reason);
        }
        await savePage(root, result, data, links, media);
        manifest.pages.push(result);
        manifest.assets = [...assets.values()];
        if (transcriber) manifest.transcripts = [...transcripts.values()];
        await saveManifest(root, manifest);
        nextAt = Date.now() + Math.max(opts.delayMs, backoff);
      }
      opts.signal?.throwIfAborted();
      await transcriber?.drain();
      opts.signal?.throwIfAborted();
      manifest.limitReached =
        queue.length > manifest.pages.length && manifest.pages.length >= opts.limit;
      manifest.status =
        manifest.pages.some((p) => p.status === "failed") ||
        manifest.assets.some((a) => a.status === "failed") ||
        [...transcripts.values()].some((t) => t.status === "failed")
          ? "partial"
          : "completed";
    } catch (err) {
      manifest.status = opts.signal?.aborted ? "interrupted" : "partial";
      if (!opts.signal?.aborted) throw err;
    } finally {
      // On errors or Ctrl+C the queue settles quickly: aborted jobs end as "Interrupted".
      await transcriber?.drain();
      manifest.finishedAt = new Date().toISOString();
      manifest.assets = [...assets.values()];
      if (transcriber) manifest.transcripts = [...transcripts.values()];
      await saveManifest(root, manifest);
      reporter.finished(manifest.status, join(root, "index.md"));
    }
    return { root, manifest };
  } finally {
    await pool.closeAll();
  }
}
