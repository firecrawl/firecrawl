import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { ArchiveReporter } from "../archive/reporter.js";
import type { TranscribeJob } from "../transcribe/queue.js";
import { Dashboard, DashboardReporter, DashboardStore, formatBytes } from "./dashboard.js";

const job = (label: string): TranscribeJob => ({
  input: `/m/${label}`,
  base: `/t/${label}`,
  label,
});
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

describe("Dashboard", () => {
  it("shows pages, the active download and one row per transcription worker", async () => {
    const store = new DashboardStore("Archiving https://example.com/", 2);
    const reporter: ArchiveReporter = new DashboardReporter(store);
    const ui = render(<Dashboard store={store} />);

    reporter.started("/data/example.com/run-1");
    reporter.page(3, 10, "https://example.com/talks");
    reporter.pageCaptured(2);
    reporter.pageFailed("https://example.com/broken", "HTTP 500");
    reporter.mediaStarted(1, 2, "https://example.com/talk.mp3", false);
    reporter.mediaProgress({
      phase: "downloading",
      attempt: 1,
      bytes: 512 * 1024,
      totalBytes: 1024 * 1024,
    });
    reporter.transcription({ type: "queued", job: job("a.mp3"), pending: 1 });
    reporter.transcription({ type: "queued", job: job("b.mp4"), pending: 2 });
    reporter.transcription({ type: "started", job: job("a.mp3"), worker: 0 });
    reporter.transcription({ type: "progress", job: job("a.mp3"), worker: 0, percent: 45 });
    await settle();

    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("Archiving https://example.com/");
    expect(frame).toContain("3/10 · 1 saved · 1 failed");
    expect(frame).toContain("[1/2] https://example.com/talk.mp3");
    expect(frame).toContain("512.0 KB of 1.0 MB");
    expect(frame).toMatch(/worker 1\s.*45% a\.mp3/);
    expect(frame).toMatch(/worker 2\s+idle/);
    expect(frame).toContain("2 waiting or running");
    expect(frame).toContain("https://example.com/broken: HTTP 500");
    expect(frame).toContain("/data/example.com/run-1");
    ui.unmount();
  });

  it("counts finished transcripts, frees workers and shows the final status", async () => {
    const store = new DashboardStore("Transcribing", 1);
    const ui = render(<Dashboard store={store} />);
    store.transcription({ type: "queued", job: job("a.mp3"), pending: 1 });
    store.transcription({ type: "started", job: job("a.mp3"), worker: 0 });
    store.transcription({
      type: "finished",
      job: job("a.mp3"),
      worker: 0,
      result: { input: "/m/a.mp3", status: "failed", reason: "whisper-cli exited with 1" },
    });
    store.transcription({
      type: "finished",
      job: job("b.mp3"),
      worker: undefined,
      result: { input: "/m/b.mp3", status: "skipped" },
    });
    store.finish("partial", `1 failed; see ${"/very/long/path".repeat(12)}/index.md`);
    await settle();

    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("0 done · 1 skipped · 1 failed");
    expect(frame).not.toContain("waiting or running");
    expect(frame).toMatch(/worker 1\s+idle/);
    expect(frame).toContain("a.mp3: whisper-cli exited with 1");
    expect(frame).toContain("partial 1 failed; see /very/long/path");
    expect(frame).not.toContain("Ctrl+C");
    ui.unmount();
  });

  it("shows the setup step, build log and model download", async () => {
    const store = new DashboardStore("Setting up transcription");
    const ui = render(<Dashboard store={store} />);
    store.setup({ type: "step", step: "build", label: "Building whisper-cli" });
    store.setup({ type: "log", line: "[ 50%] Building CUDA object" });
    store.setup({ type: "step", step: "model", label: "Downloading model" });
    store.setup({ type: "download", bytes: 300 * 1024 * 1024, totalBytes: 600 * 1024 * 1024 });
    await settle();

    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("Downloading model");
    expect(frame).toContain("300.0 MB of 600.0 MB");
    expect(frame).not.toContain("Building CUDA object"); // the log resets per step
    ui.unmount();
  });

  it("shows Docker Compose output from API startup in the setup section", async () => {
    const store = new DashboardStore("Archiving https://example.com/");
    const reporter: ArchiveReporter = new DashboardReporter(store);
    const ui = render(<Dashboard store={store} />);
    reporter.setup({ type: "step", label: "Local API unavailable; starting Docker Compose…" });
    reporter.setup({ type: "log", line: " Container firecrawl-redis-1  Started" });
    reporter.setup({ type: "log", line: " Container firecrawl-api-1  Starting" });
    await settle();

    const frame = ui.lastFrame() ?? "";
    expect(frame).toMatch(/Setup\s+Local API unavailable; starting Docker Compose…/);
    expect(frame).toContain("Container firecrawl-redis-1  Started");
    expect(frame).toContain("Container firecrawl-api-1  Starting");
    ui.unmount();
  });

  it("keeps each error to one short line", async () => {
    const store = new DashboardStore("Archiving");
    const ui = render(<Dashboard store={store} />);
    store.error(`https://x.test/: 501 <!DOCTYPE HTML>\n<html>\n  <body>${"x".repeat(400)}</body>`);
    await settle();

    const errorLines = (ui.lastFrame() ?? "").split("\n").filter((l) => l.includes("x.test"));
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]).toContain("501 <!DOCTYPE HTML> <html> <body>xxx");
    expect(store.getSnapshot().errors[0]).toHaveLength(200);
    ui.unmount();
  });

  it("formats byte counts", () => {
    expect(formatBytes(900)).toBe("900 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3.0 GB");
  });
});
