import pLimit from "p-limit";
import {
  isTranscribed,
  transcribeFile,
  TRANSCRIPT_EXTENSIONS,
  type TranscribeOutput,
  type TranscribeSettings,
} from "./transcribe.js";

export interface TranscribeJob {
  /** Media file to transcribe. */
  input: string;
  /** Output path without extension. */
  base: string;
  /** Short name for progress displays. */
  label: string;
}

export interface TranscriptResult {
  input: string;
  status: "transcribed" | "skipped" | "failed";
  files?: string[];
  language?: string | undefined;
  durationSec?: number;
  segments?: number;
  reason?: string;
}

export type TranscribeEvent =
  | { type: "queued"; job: TranscribeJob; pending: number }
  | { type: "started"; job: TranscribeJob; worker: number }
  | { type: "progress"; job: TranscribeJob; worker: number; percent: number }
  | { type: "finished"; job: TranscribeJob; worker: number | undefined; result: TranscriptResult };

export type TranscribeRunner = (
  input: string,
  base: string,
  onProgress: (percent: number) => void,
  signal: AbortSignal | undefined,
) => Promise<TranscribeOutput>;

export interface TranscribeQueueOptions {
  workers: number;
  settings: TranscribeSettings;
  signal?: AbortSignal | undefined;
  onEvent?: ((event: TranscribeEvent) => void) | undefined;
  /** Replaces whisper for tests. */
  runner?: TranscribeRunner;
}

/**
 * Transcribes media concurrently: each of the N workers runs its own
 * whisper process, so jobs share the GPU while the scrape keeps going.
 */
export class TranscribeQueue {
  private readonly limit;
  private readonly free: number[];
  private readonly runs: Array<Promise<TranscriptResult>> = [];
  private readonly runner: TranscribeRunner;
  private pending = 0;

  constructor(private readonly opts: TranscribeQueueOptions) {
    if (!Number.isSafeInteger(opts.workers) || opts.workers < 1)
      throw new Error("Transcription needs at least one worker");
    this.limit = pLimit(opts.workers);
    this.free = Array.from({ length: opts.workers }, (_, i) => opts.workers - 1 - i);
    this.runner =
      opts.runner ??
      ((input, base, onProgress, signal) =>
        transcribeFile(input, base, opts.settings, onProgress, signal));
  }

  /** Queue a file; finished transcripts (a `.txt` exists) are skipped. */
  add(job: TranscribeJob): Promise<TranscriptResult> {
    if (isTranscribed(job.base)) {
      const result: TranscriptResult = {
        input: job.input,
        status: "skipped",
        files: TRANSCRIPT_EXTENSIONS.map((ext) => `${job.base}${ext}`),
        reason: "Already transcribed",
      };
      this.opts.onEvent?.({ type: "finished", job, worker: undefined, result });
      const done = Promise.resolve(result);
      this.runs.push(done);
      return done;
    }
    this.pending++;
    this.opts.onEvent?.({ type: "queued", job, pending: this.pending });
    const run = this.limit(() => this.run(job));
    this.runs.push(run);
    return run;
  }

  /** Wait for every queued job; results are in the order they were added. */
  async drain(): Promise<TranscriptResult[]> {
    let count = 0;
    while (count !== this.runs.length) {
      count = this.runs.length;
      // Jobs may be added while earlier ones run, so wait again until none are new.
      // oxlint-disable-next-line no-await-in-loop
      await Promise.all(this.runs);
    }
    return Promise.all(this.runs);
  }

  private async run(job: TranscribeJob): Promise<TranscriptResult> {
    this.pending--;
    const worker = this.free.pop()!;
    let result: TranscriptResult;
    try {
      this.opts.signal?.throwIfAborted();
      this.opts.onEvent?.({ type: "started", job, worker });
      const output = await this.runner(
        job.input,
        job.base,
        (percent) => this.opts.onEvent?.({ type: "progress", job, worker, percent }),
        this.opts.signal,
      );
      result = { input: job.input, status: "transcribed", ...output };
    } catch (err) {
      result = {
        input: job.input,
        status: "failed",
        reason: this.opts.signal?.aborted
          ? "Interrupted"
          : err instanceof Error
            ? err.message
            : String(err),
      };
    } finally {
      this.free.push(worker);
    }
    this.opts.onEvent?.({ type: "finished", job, worker, result });
    return result;
  }
}
