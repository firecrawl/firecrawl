import type { StepEvent } from "../lib/progress.js";
import type { TranscribeEvent } from "../transcribe/queue.js";
import type { MediaResult, MediaTransferProgress } from "./download.js";
import { MediaProgress } from "./media-progress.js";
import type { Manifest } from "./storage.js";

/** Everything an archive run reports while it works, for text or the Ink dashboard. */
export interface ArchiveReporter {
  /** Preparation before crawling, e.g. starting the local API with Docker Compose. */
  setup(event: StepEvent): void;
  started(root: string): void;
  page(index: number, limit: number, url: string): void;
  pageCaptured(mediaCount: number): void;
  pageFailed(url: string, reason: string): void;
  mediaStarted(index: number, total: number, url: string, reused: boolean): void;
  mediaProgress(progress: MediaTransferProgress): void;
  mediaFinished(asset: MediaResult, reused: boolean): void;
  /** The page's media loop ended, normally or not. */
  mediaDone(): void;
  transcription(event: TranscribeEvent): void;
  finished(status: Manifest["status"], index: string): void;
}

interface TextStream {
  write(text: string): unknown;
  isTTY?: boolean | undefined;
}

/** Plain progress lines on stderr: the output for pipes, CI and `--no-ui`. */
export class TextReporter implements ArchiveReporter {
  private readonly media: MediaProgress;

  constructor(private readonly stream: TextStream = process.stderr) {
    this.media = new MediaProgress(stream);
  }

  setup(event: StepEvent): void {
    this.line(event.type === "step" ? event.label : `  ${event.line}`);
  }

  started(root: string): void {
    this.line(`Archive directory: ${root}`);
  }

  page(index: number, limit: number, url: string): void {
    this.line(`[${index}/${limit}] ${url}`);
  }

  pageCaptured(mediaCount: number): void {
    this.line(`  captured page; ${mediaCount} media items to process`);
  }

  pageFailed(url: string, reason: string): void {
    this.line(`FAIL ${url}: ${reason}`);
  }

  mediaStarted(index: number, total: number, url: string, reused: boolean): void {
    this.media.start(index, total, url, reused);
  }

  mediaProgress(progress: MediaTransferProgress): void {
    this.media.update(progress);
  }

  mediaFinished(asset: MediaResult, reused: boolean): void {
    this.media.finish(asset, reused);
  }

  mediaDone(): void {
    this.media.stop();
  }

  transcription(event: TranscribeEvent): void {
    const name = `  transcribe ${event.job.label}`;
    if (event.type === "started") this.line(`${name} — started on worker ${event.worker + 1}`);
    if (event.type !== "finished") return;
    const r = event.result;
    this.line(
      r.status === "transcribed"
        ? `${name} — done: ${r.segments} segments, ${r.durationSec}s of audio, language ${r.language ?? "unknown"}`
        : `${name} — ${r.status}: ${r.reason ?? ""}`,
    );
  }

  finished(status: Manifest["status"], index: string): void {
    this.line(`Archive ${status}: ${index}`);
  }

  private line(text: string): void {
    // Clear any in-place media progress line first; it redraws on its next tick.
    this.stream.write(this.stream.isTTY ? `\r\u001B[2K${text}\n` : `${text}\n`);
  }
}
