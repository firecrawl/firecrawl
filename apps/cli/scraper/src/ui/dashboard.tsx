import { ProgressBar, Spinner } from "@inkjs/ui";
import { Box, Text } from "ink";
import { useSyncExternalStore } from "react";
import type { MediaResult, MediaTransferProgress } from "../archive/download.js";
import type { ArchiveReporter } from "../archive/reporter.js";
import type { Manifest } from "../archive/storage.js";
import type { StepEvent } from "../lib/progress.js";
import type { InstallEvent } from "../transcribe/install.js";
import type { TranscribeEvent } from "../transcribe/queue.js";

interface WorkerRow {
  label: string;
  percent: number;
}

export interface DashboardState {
  title: string;
  root?: string | undefined;
  pages?: { index: number; limit: number; url: string; saved: number; failed: number } | undefined;
  media: {
    active?:
      | {
          index: number;
          total: number;
          url: string;
          bytes: number;
          totalBytes?: number | undefined;
        }
      | undefined;
    downloaded: number;
    reused: number;
    skipped: number;
    failed: number;
  };
  /** One slot per transcription worker; undefined while idle. */
  workers: Array<WorkerRow | undefined>;
  transcripts: { queued: number; transcribed: number; skipped: number; failed: number };
  /** Preparation: building whisper.cpp or starting the local API. */
  setup?:
    | {
        label: string;
        log: string[];
        download?: { bytes: number; totalBytes: number | undefined } | undefined;
      }
    | undefined;
  errors: string[];
  done?: { status: string; detail: string } | undefined;
}

const MAX_ERRORS = 5;
const MAX_ERROR_LENGTH = 200;
const LOG_LINES = 6;

/** Holds dashboard state outside React so run code can update it from anywhere. */
export class DashboardStore {
  private state: DashboardState;
  private readonly listeners = new Set<() => void>();

  constructor(title: string, workers = 0) {
    this.state = {
      title,
      media: { downloaded: 0, reused: 0, skipped: 0, failed: 0 },
      workers: Array.from({ length: workers }, () => undefined),
      transcripts: { queued: 0, transcribed: 0, skipped: 0, failed: 0 },
      errors: [],
    };
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): DashboardState => this.state;

  update(change: (state: DashboardState) => DashboardState): void {
    this.state = change(this.state);
    for (const listener of this.listeners) listener();
  }

  error(message: string): void {
    // Errors can carry whole response bodies; keep each to one short line.
    const line = message.replace(/\s+/g, " ").trim();
    const short = line.length > MAX_ERROR_LENGTH ? `${line.slice(0, MAX_ERROR_LENGTH - 1)}…` : line;
    this.update((s) => ({ ...s, errors: [...s.errors, short].slice(-MAX_ERRORS) }));
  }

  transcription(event: TranscribeEvent): void {
    this.update((s) => {
      const workers = [...s.workers];
      const t = { ...s.transcripts };
      if (event.type === "queued") t.queued++;
      if (event.type === "started") workers[event.worker] = { label: event.job.label, percent: 0 };
      if (event.type === "progress")
        workers[event.worker] = { label: event.job.label, percent: event.percent };
      if (event.type === "finished") {
        if (event.worker !== undefined) {
          workers[event.worker] = undefined;
          t.queued--;
        }
        t[event.result.status]++;
      }
      return { ...s, workers, transcripts: t };
    });
    if (event.type === "finished" && event.result.status === "failed")
      this.error(`${event.job.label}: ${event.result.reason ?? "transcription failed"}`);
  }

  setup(event: InstallEvent | StepEvent): void {
    this.update((s) => {
      const setup = s.setup ?? { label: "", log: [] };
      if (event.type === "step") return { ...s, setup: { label: event.label, log: [] } };
      if (event.type === "log")
        return {
          ...s,
          setup: { ...setup, log: [...setup.log, event.line].slice(-LOG_LINES) },
        };
      return {
        ...s,
        setup: { ...setup, download: { bytes: event.bytes, totalBytes: event.totalBytes } },
      };
    });
  }

  finish(status: string, detail: string): void {
    this.update((s) => ({ ...s, done: { status, detail } }));
  }
}

/** Feeds an archive run's events into the dashboard. */
export class DashboardReporter implements ArchiveReporter {
  constructor(private readonly store: DashboardStore) {}

  setup(event: StepEvent): void {
    this.store.setup(event);
  }

  started(root: string): void {
    this.store.update((s) => ({ ...s, root }));
  }

  page(index: number, limit: number, url: string): void {
    this.store.update((s) => ({
      ...s,
      pages: { saved: 0, failed: 0, ...s.pages, index, limit, url },
    }));
  }

  pageCaptured(): void {
    this.store.update((s) =>
      s.pages ? { ...s, pages: { ...s.pages, saved: s.pages.saved + 1 } } : s,
    );
  }

  pageFailed(url: string, reason: string): void {
    this.store.update((s) =>
      s.pages ? { ...s, pages: { ...s.pages, failed: s.pages.failed + 1 } } : s,
    );
    this.store.error(`${url}: ${reason}`);
  }

  mediaStarted(index: number, total: number, url: string): void {
    this.store.update((s) => ({
      ...s,
      media: { ...s.media, active: { index, total, url, bytes: 0 } },
    }));
  }

  mediaProgress(progress: MediaTransferProgress): void {
    this.store.update((s) =>
      s.media.active
        ? {
            ...s,
            media: {
              ...s.media,
              active: { ...s.media.active, bytes: progress.bytes, totalBytes: progress.totalBytes },
            },
          }
        : s,
    );
  }

  mediaFinished(asset: MediaResult, reused: boolean): void {
    this.store.update((s) => {
      const media = { ...s.media };
      if (reused) media.reused++;
      else if (asset.status === "downloaded") media.downloaded++;
      else media[asset.status]++;
      return { ...s, media };
    });
    if (asset.status === "failed") this.store.error(`${asset.url}: ${asset.reason ?? "failed"}`);
  }

  mediaDone(): void {
    this.store.update((s) => ({ ...s, media: { ...s.media, active: undefined } }));
  }

  transcription(event: TranscribeEvent): void {
    this.store.transcription(event);
  }

  finished(status: Manifest["status"], index: string): void {
    this.store.finish(status, index);
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function percentOf(bytes: number, total: number | undefined): number | undefined {
  return total ? Math.min(100, Math.round((bytes / total) * 100)) : undefined;
}

/** Positional keys for lists whose position is their identity (worker slots, text windows). */
function keyed<T>(
  items: readonly T[],
  prefix: string,
): Array<{ key: string; item: T; index: number }> {
  return items.map((item, index) => ({ key: `${prefix}${index}`, item, index }));
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box>
      <Box width={14} flexShrink={0}>
        <Text dimColor>{label}</Text>
      </Box>
      <Box flexGrow={1}>{children}</Box>
    </Box>
  );
}

function Bar({ value, text }: { value: number; text: string }) {
  return (
    <Box gap={1}>
      <Box width={30}>
        <ProgressBar value={value} />
      </Box>
      <Text>{text}</Text>
    </Box>
  );
}

const STATUS_COLORS: Record<string, string> = {
  completed: "green",
  partial: "yellow",
  interrupted: "yellow",
  failed: "red",
};

export function Dashboard({ store }: { store: DashboardStore }) {
  const s = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const t = s.transcripts;
  const busy = s.workers.some(Boolean) || t.queued > 0;
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box gap={1} marginBottom={1}>
        {s.done ? <Text color={STATUS_COLORS[s.done.status] ?? "white"}>●</Text> : <Spinner />}
        <Text bold>{s.title}</Text>
      </Box>

      {s.setup && (
        <Box flexDirection="column" marginBottom={1}>
          <Row label="Setup">
            <Text>{s.setup.label}</Text>
          </Row>
          {s.setup.download && (
            <Row label="Download">
              <Bar
                value={percentOf(s.setup.download.bytes, s.setup.download.totalBytes) ?? 0}
                text={`${formatBytes(s.setup.download.bytes)}${s.setup.download.totalBytes ? ` of ${formatBytes(s.setup.download.totalBytes)}` : ""}`}
              />
            </Row>
          )}
          {keyed(s.setup.log, "log").map(({ key, item: line }) => (
            <Text key={key} dimColor wrap="truncate-end">
              {"  "}
              {line}
            </Text>
          ))}
        </Box>
      )}

      {s.pages && (
        <>
          <Row label="Pages">
            <Bar
              value={Math.round((s.pages.index / Math.max(1, s.pages.limit)) * 100)}
              text={`${s.pages.index}/${s.pages.limit} · ${s.pages.saved} saved · ${s.pages.failed} failed`}
            />
          </Row>
          <Row label="">
            <Text dimColor wrap="truncate-middle">
              {s.pages.url}
            </Text>
          </Row>
        </>
      )}

      {(s.pages || s.media.active) && (
        <Row label="Media">
          <Text>
            {s.media.downloaded} downloaded · {s.media.reused} reused · {s.media.skipped} skipped ·{" "}
            {s.media.failed} failed
          </Text>
        </Row>
      )}
      {s.media.active && (
        <Row label="">
          <Box flexDirection="column">
            <Text dimColor wrap="truncate-middle">
              [{s.media.active.index}/{s.media.active.total}] {s.media.active.url}
            </Text>
            <Bar
              value={percentOf(s.media.active.bytes, s.media.active.totalBytes) ?? 0}
              text={`${formatBytes(s.media.active.bytes)}${s.media.active.totalBytes ? ` of ${formatBytes(s.media.active.totalBytes)}` : ""}`}
            />
          </Box>
        </Row>
      )}

      {s.workers.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Row label="Transcripts">
            <Text>
              {t.transcribed} done · {t.skipped} skipped · {t.failed} failed
              {busy ? ` · ${t.queued} waiting or running` : ""}
            </Text>
          </Row>
          {keyed(s.workers, "worker").map(({ key, item: w, index }) => (
            <Row key={key} label={`  worker ${index + 1}`}>
              {w ? (
                <Bar value={w.percent} text={`${String(w.percent).padStart(3)}% ${w.label}`} />
              ) : (
                <Text dimColor>idle</Text>
              )}
            </Row>
          ))}
        </Box>
      )}

      {s.errors.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="red">Recent errors</Text>
          {keyed(s.errors, "error").map(({ key, item: e }) => (
            <Text key={key} color="red" wrap="truncate-end">
              {"  "}
              {e}
            </Text>
          ))}
        </Box>
      )}

      {s.root && (
        <Box marginTop={1}>
          <Row label="Output">
            <Text>{s.root}</Text>
          </Row>
        </Box>
      )}
      {s.done && (
        <Box marginTop={1} gap={1}>
          {/* A long detail (a path) must wrap rather than squeeze the status word. */}
          <Box flexShrink={0}>
            <Text color={STATUS_COLORS[s.done.status] ?? "white"} bold>
              {s.done.status}
            </Text>
          </Box>
          <Text>{s.done.detail}</Text>
        </Box>
      )}
      {!s.done && (
        <Text dimColor>{"\n"}Ctrl+C stops the run and keeps everything saved so far.</Text>
      )}
    </Box>
  );
}
