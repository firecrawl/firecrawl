import { SingleBar, Presets } from "cli-progress";

export interface Progress {
  start(total: number): void;
  tick(label?: string): void;
  stop(): void;
}

class TtyProgress implements Progress {
  private readonly bar: SingleBar;

  constructor() {
    this.bar = new SingleBar(
      {
        format: "  {bar} {percentage}% | {value}/{total} | {label}",
        hideCursor: true,
        stream: process.stderr,
      },
      Presets.shades_classic,
    );
  }

  start(total: number): void {
    this.bar.start(total, 0, { label: "" });
  }

  tick(label?: string): void {
    this.bar.increment(1, { label: label ?? "" });
  }

  stop(): void {
    this.bar.stop();
  }
}

class NoopProgress implements Progress {
  start(): void {}
  tick(): void {}
  stop(): void {}
}

export function makeProgress(opts: { enabled: boolean; outputIsStdout: boolean }): Progress {
  if (!opts.enabled) return new NoopProgress();
  if (opts.outputIsStdout) return new NoopProgress();
  if (!process.stderr.isTTY) return new NoopProgress();
  return new TtyProgress();
}
