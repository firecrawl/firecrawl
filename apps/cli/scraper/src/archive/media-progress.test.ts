import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaProgress } from "./media-progress.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("media progress display", () => {
  it("keeps reporting while waiting, then shows bytes, percentage and completion", () => {
    const write = vi.fn();
    const progress = new MediaProgress({ write });
    progress.start(2, 10, "https://cdn.example.com/image.png?token=secret");
    vi.advanceTimersByTime(1000);
    expect(write.mock.calls.at(-1)?.[0]).toContain("waiting for response (attempt 1/3) · 1s");
    progress.update({ phase: "downloading", attempt: 1, bytes: 1000, totalBytes: 4000 });
    vi.advanceTimersByTime(1000);
    expect(write.mock.calls.at(-1)?.[0]).toContain(
      "media [2/10] cdn.example.com/image.png — 1.0 KB / 4.0 KB (25%) · 2s",
    );
    progress.finish({
      url: "https://cdn.example.com/image.png",
      kind: "image",
      status: "downloaded",
      bytes: 4000,
    });
    expect(write.mock.calls.at(-1)?.[0]).toContain("downloaded 4.0 KB");
    expect(write.mock.calls.map((call) => call[0]).join("")).not.toContain("secret");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("handles unknown totals and reports retry countdowns", () => {
    const write = vi.fn();
    const progress = new MediaProgress({ write });
    progress.start(1, 1, "https://example.com/chunked");
    progress.update({ phase: "downloading", attempt: 1, bytes: 512 });
    vi.advanceTimersByTime(1000);
    expect(write.mock.calls.at(-1)?.[0]).toContain("512 B downloaded");
    expect(write.mock.calls.at(-1)?.[0]).not.toContain("%");
    progress.update({ phase: "retrying", attempt: 1, bytes: 0, retryAfterMs: 3000 });
    vi.advanceTimersByTime(1000);
    expect(write.mock.calls.at(-1)?.[0]).toContain("retry in 2s (attempt 1/3)");
    progress.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("updates a TTY in place and stops cleanly after interruption", () => {
    const write = vi.fn();
    const progress = new MediaProgress({ write, isTTY: true });
    progress.start(1, 2, "https://example.com/movie.mp4");
    expect(write.mock.calls[0]?.[0].startsWith("\r\x1b[2K")).toBe(true);
    progress.stop();
    expect(write.mock.calls.at(-1)?.[0]).toMatch(/interrupted\n$/);
    const count = write.mock.calls.length;
    vi.advanceTimersByTime(5000);
    expect(write).toHaveBeenCalledTimes(count);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports reused, skipped and failed items without leaving timers running", () => {
    const write = vi.fn();
    const progress = new MediaProgress({ write });
    for (const status of ["downloaded", "skipped", "failed"] as const) {
      progress.start(1, 1, "https://example.com/media", status === "downloaded");
      progress.finish(
        { url: "https://example.com/media", kind: "image", status, reason: "example reason" },
        status === "downloaded",
      );
      expect(write.mock.calls.at(-1)?.[0]).toContain(
        status === "downloaded" ? "reused" : `${status}: example reason`,
      );
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});
