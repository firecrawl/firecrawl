import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TranscribeQueue, type TranscribeEvent, type TranscribeRunner } from "./queue.js";
import type { TranscribeSettings } from "./transcribe.js";

const settings: TranscribeSettings = {
  whisper: { bin: "unused", model: "unused" },
  language: "auto",
  threads: 1,
  gpu: false,
};

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "transcribe-queue-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const job = (name: string) => ({ input: `/media/${name}.mp3`, base: join(dir, name), label: name });

function trackingRunner(): { runner: TranscribeRunner; peak: () => number } {
  let active = 0;
  let peak = 0;
  return {
    peak: () => peak,
    runner: async (_input, _base, onProgress, signal) => {
      active++;
      peak = Math.max(peak, active);
      try {
        onProgress(50);
        await sleep(20, undefined, { signal });
        return { files: [], language: "en", durationSec: 1, segments: 1 };
      } finally {
        active--;
      }
    },
  };
}

describe("TranscribeQueue", () => {
  it("runs at most N jobs at once, each on a distinct worker slot", async () => {
    const { runner, peak } = trackingRunner();
    const events: TranscribeEvent[] = [];
    const queue = new TranscribeQueue({
      workers: 2,
      settings,
      runner,
      onEvent: (e) => events.push(e),
    });
    for (const name of ["a", "b", "c", "d", "e"]) void queue.add(job(name));
    const results = await queue.drain();
    expect(results.map((r) => r.status)).toEqual(Array(5).fill("transcribed"));
    expect(peak()).toBe(2);
    const started = events.filter((e) => e.type === "started");
    expect(new Set(started.map((e) => e.worker))).toEqual(new Set([0, 1]));
    expect(events.filter((e) => e.type === "progress")).toHaveLength(5);
  });

  it("drains jobs added while others are running", async () => {
    const { runner } = trackingRunner();
    const queue = new TranscribeQueue({ workers: 1, settings, runner });
    void queue.add(job("first")).then(() => queue.add(job("second")));
    await sleep(5);
    expect((await queue.drain()).map((r) => r.input)).toEqual([
      "/media/first.mp3",
      "/media/second.mp3",
    ]);
  });

  it("skips files that already have a transcript", async () => {
    await writeFile(join(dir, "done.txt"), "[00:00:00.000 → 00:00:01.000] hi\n");
    const { runner, peak } = trackingRunner();
    const queue = new TranscribeQueue({ workers: 1, settings, runner });
    expect(await queue.add(job("done"))).toMatchObject({
      status: "skipped",
      reason: "Already transcribed",
    });
    expect(peak()).toBe(0);
  });

  it("marks running and queued jobs as interrupted on abort", async () => {
    const controller = new AbortController();
    const { runner } = trackingRunner();
    const queue = new TranscribeQueue({
      workers: 1,
      settings,
      runner,
      signal: controller.signal,
    });
    for (const name of ["x", "y"]) void queue.add(job(name));
    await sleep(5);
    controller.abort();
    expect(await queue.drain()).toEqual([
      { input: "/media/x.mp3", status: "failed", reason: "Interrupted" },
      { input: "/media/y.mp3", status: "failed", reason: "Interrupted" },
    ]);
  });

  it("reports runner errors per job", async () => {
    const queue = new TranscribeQueue({
      workers: 1,
      settings,
      runner: async () => {
        throw new Error("model file is corrupt");
      },
    });
    expect(await queue.add(job("bad"))).toMatchObject({
      status: "failed",
      reason: "model file is corrupt",
    });
  });
});
