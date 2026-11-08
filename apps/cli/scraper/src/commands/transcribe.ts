import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { cpus } from "node:os";
import { basename, extname, join, relative, resolve } from "node:path";
import { saveManifest, type Manifest, type TranscriptEntry } from "../archive/storage.js";
import {
  TranscribeQueue,
  type TranscribeEvent,
  type TranscribeJob,
  type TranscribeRunner,
  type TranscriptResult,
} from "../transcribe/queue.js";
import type { Config } from "../config.js";
import { assertWhisperReady, resolveWhisper } from "../transcribe/setup.js";
import type { TranscribeSettings } from "../transcribe/transcribe.js";

const AUDIO_EXTENSIONS = [
  ".mp3",
  ".m4a",
  ".aac",
  ".wav",
  ".ogg",
  ".oga",
  ".opus",
  ".flac",
  ".weba",
];
const VIDEO_EXTENSIONS = [".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi"];
const MEDIA_EXTENSIONS = new Set([...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS]);

/** CPU threads per whisper process so that N workers share the cores. */
export function threadsPerWorker(workers: number, cores = cpus().length): number {
  return Math.max(1, Math.min(8, Math.floor(cores / Math.max(1, workers))));
}

export interface TranscribeChoices {
  workers: number;
  /** Whisper language code, or "auto" to detect it. */
  language: string;
  /** Model file; defaults to config, then the installed default model. */
  model?: string | undefined;
  /** Run whisper on the CPU only. */
  cpu: boolean;
}

/** Whisper settings for the chosen workers, sharing the CPU cores between them. */
export function transcribeSettings(
  config: Pick<Config, "transcribe">,
  choices: TranscribeChoices,
): TranscribeSettings {
  return {
    whisper: resolveWhisper(config, { model: choices.model }),
    language: choices.language,
    threads: threadsPerWorker(choices.workers),
    gpu: !choices.cpu,
  };
}

export interface TranscribeOptions {
  /** Archive run directories, media files, or folders of media. */
  inputs: string[];
  workers: number;
  settings: TranscribeSettings;
  onEvent?: ((event: TranscribeEvent) => void) | undefined;
  signal?: AbortSignal | undefined;
  /** Replaces whisper for tests. */
  runner?: TranscribeRunner;
}

interface ArchivePlan {
  root: string;
  manifest: Manifest;
  jobs: Array<{ job: TranscribeJob; asset: string; media: string }>;
}

async function mediaFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && MEDIA_EXTENSIONS.has(extname(e.name).toLowerCase()))
    .map((e) => join(e.parentPath, e.name))
    .toSorted();
}

async function archivePlan(root: string): Promise<ArchivePlan> {
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as Manifest;
  const jobs = manifest.assets
    .filter(
      (a) => a.status === "downloaded" && a.path && (a.kind === "audio" || a.kind === "video"),
    )
    .map((a) => {
      const stem = basename(a.path!, extname(a.path!));
      return {
        asset: a.url,
        media: a.path!,
        job: { input: join(root, a.path!), base: join(root, "transcripts", stem), label: stem },
      };
    });
  return { root, manifest, jobs };
}

function entry(asset: string, media: string, root: string, r: TranscriptResult): TranscriptEntry {
  return {
    asset,
    media,
    status: r.status,
    files: r.files?.map((file) => relative(root, file)),
    language: r.language,
    durationSec: r.durationSec,
    segments: r.segments,
    reason: r.reason,
  };
}

type Found = { kind: "archive"; plan: ArchivePlan } | { kind: "files"; jobs: TranscribeJob[] };

function fileJob(file: string): TranscribeJob {
  const ext = extname(file);
  return { input: file, base: ext ? file.slice(0, -ext.length) : file, label: basename(file) };
}

/** An archive run directory, a single media file, or a folder searched for media. */
async function classify(raw: string): Promise<Found> {
  const input = resolve(raw);
  if (!existsSync(input)) throw new Error(`No such file or directory: ${raw}`);
  if ((await stat(input)).isFile()) return { kind: "files", jobs: [fileJob(input)] };
  if (existsSync(join(input, "manifest.json")))
    return { kind: "archive", plan: await archivePlan(input) };
  return { kind: "files", jobs: (await mediaFiles(input)).map((file) => fileJob(file)) };
}

/**
 * Transcribe past archive runs (updating their manifest and index) or plain
 * media files (transcripts are written next to each file).
 */
export async function runTranscribe(opts: TranscribeOptions): Promise<TranscriptResult[]> {
  if (!opts.runner) assertWhisperReady(opts.settings.whisper);
  const found = await Promise.all(opts.inputs.map((raw) => classify(raw)));
  const archives = found.flatMap((f) => (f.kind === "archive" ? [f.plan] : []));
  const files = found.flatMap((f) => (f.kind === "files" ? f.jobs : []));
  if (archives.every((a) => a.jobs.length === 0) && files.length === 0)
    throw new Error("No audio or video files found to transcribe");

  const queue = new TranscribeQueue({
    workers: opts.workers,
    settings: opts.settings,
    signal: opts.signal,
    onEvent: opts.onEvent,
    ...(opts.runner ? { runner: opts.runner } : {}),
  });
  const archiveRuns = archives.map(async (plan) => {
    const results = await Promise.all(plan.jobs.map(({ job }) => queue.add(job)));
    const byMedia = new Map((plan.manifest.transcripts ?? []).map((t) => [t.media, t]));
    plan.jobs.forEach(({ asset, media }, i) => {
      const result = results[i]!;
      // Keep a previous entry's details when this run only skipped it.
      if (result.status !== "skipped" || !byMedia.has(media))
        byMedia.set(media, entry(asset, media, plan.root, result));
    });
    plan.manifest.transcripts = [...byMedia.values()];
    await saveManifest(plan.root, plan.manifest);
    return results;
  });
  const fileRuns = files.map((job) => queue.add(job));
  const [archiveResults, fileResults] = await Promise.all([
    Promise.all(archiveRuns),
    Promise.all(fileRuns),
  ]);
  return [...archiveResults.flat(), ...fileResults];
}
