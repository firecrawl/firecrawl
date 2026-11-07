import type { MediaResult, MediaTransferProgress } from "./download.js";

interface ProgressStream {
  write(text: string): unknown;
  isTTY?: boolean | undefined;
}

function bytesLabel(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function safeLabel(value: string): string {
  return [...value]
    .map((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159) ? " " : char;
    })
    .join("")
    .slice(0, 120);
}

export class MediaProgress {
  private timer: ReturnType<typeof setInterval> | undefined;
  private prefix = "";
  private startedAt = 0;
  private retryAt = 0;
  private active = false;
  private transfer: MediaTransferProgress = { phase: "requesting", attempt: 1, bytes: 0 };

  constructor(private readonly stream: ProgressStream = process.stderr) {}

  start(index: number, total: number, url: string, reused = false): void {
    this.stop();
    const parsed = new URL(url);
    // Exclude query strings: media URLs can contain signed access tokens.
    this.prefix = `  media [${index}/${total}] ${safeLabel(parsed.host + parsed.pathname)}`;
    this.startedAt = Date.now();
    this.transfer = { phase: "requesting", attempt: 1, bytes: 0 };
    this.active = true;
    if (reused) return;
    this.render();
    // A heartbeat also covers slow response headers and stalled transfer bodies.
    this.timer = setInterval(() => this.render(), 1000);
    this.timer.unref();
  }

  update = (progress: MediaTransferProgress): void => {
    this.transfer = progress;
    if (progress.phase === "retrying") this.retryAt = Date.now() + (progress.retryAfterMs ?? 0);
  };

  finish(result: MediaResult, reused = false): void {
    this.clearTimer();
    const detail =
      result.status === "downloaded"
        ? reused
          ? "reused"
          : `downloaded ${bytesLabel(result.bytes ?? 0)}`
        : `${reused ? "reused " : ""}${result.status}: ${safeLabel(result.reason ?? "")}`;
    this.write(`${this.prefix} — ${detail}`, true);
    this.active = false;
  }

  stop(): void {
    this.clearTimer();
    if (this.active) this.write(`${this.prefix} — interrupted`, true);
    this.active = false;
  }

  private clearTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private render(): void {
    const elapsed = Math.floor((Date.now() - this.startedAt) / 1000);
    const { phase, bytes, totalBytes, attempt } = this.transfer;
    let detail: string;
    if (phase === "requesting") detail = `waiting for response (attempt ${attempt}/3)`;
    else if (phase === "retrying")
      detail = `retry in ${Math.ceil(Math.max(0, this.retryAt - Date.now()) / 1000)}s (attempt ${attempt}/3)`;
    else
      detail = totalBytes
        ? `${bytesLabel(bytes)} / ${bytesLabel(totalBytes)} (${Math.min(100, Math.floor((bytes / totalBytes) * 100))}%)`
        : `${bytesLabel(bytes)} downloaded`;
    this.write(`${this.prefix} — ${detail} · ${elapsed}s`, false);
  }

  private write(line: string, final: boolean): void {
    this.stream.write(this.stream.isTTY ? `\r\x1b[2K${line}${final ? "\n" : ""}` : `${line}\n`);
  }
}
