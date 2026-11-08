import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Manifest } from "../archive/storage.js";
import type { TranscribeRunner } from "../transcribe/queue.js";
import type { TranscribeSettings } from "../transcribe/transcribe.js";
import { runTranscribe, threadsPerWorker } from "./transcribe.js";

const settings: TranscribeSettings = {
  whisper: { bin: "/missing/whisper-cli", model: "/missing/model.bin" },
  language: "auto",
  threads: 2,
  gpu: false,
};

const EXTENSIONS = [".srt", ".vtt", ".json", ".txt"];

/** Writes the four transcript files like whisper would. */
const fakeRunner =
  (seen: string[] = []): TranscribeRunner =>
  async (input, base) => {
    seen.push(input);
    await mkdir(join(base, ".."), { recursive: true });
    await Promise.all(EXTENSIONS.map((ext) => writeFile(base + ext, `transcript of ${input}`)));
    return {
      files: EXTENSIONS.map((ext) => base + ext),
      language: "en",
      durationSec: 4,
      segments: 3,
    };
  };

function manifest(): Manifest {
  return {
    sourceUrl: "https://example.test/",
    engine: "api",
    startedAt: "2026-11-08T00:00:00.000Z",
    status: "completed",
    settings: { limit: 5, maxMediaMb: 10, delayMs: 0, playMedia: false, media: ["audio"] },
    limitReached: false,
    pages: [],
    assets: [
      {
        url: "https://example.test/a.mp3",
        kind: "audio",
        status: "downloaded",
        path: "media/a--1.mp3",
      },
      {
        url: "https://example.test/b.png",
        kind: "image",
        status: "downloaded",
        path: "media/b.png",
      },
      { url: "https://example.test/c.mp3", kind: "audio", status: "failed", reason: "404" },
    ],
  };
}

describe("runTranscribe", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "transcribe-cmd-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("transcribes an archive run and records it in the manifest and index", async () => {
    await mkdir(join(dir, "media"));
    await writeFile(join(dir, "media/a--1.mp3"), "audio");
    await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest()));

    const seen: string[] = [];
    const results = await runTranscribe({
      inputs: [dir],
      workers: 2,
      settings,
      runner: fakeRunner(seen),
    });

    expect(seen).toEqual([join(dir, "media/a--1.mp3")]);
    expect(results.map((r) => r.status)).toEqual(["transcribed"]);
    const saved = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as Manifest;
    expect(saved.transcripts).toEqual([
      {
        asset: "https://example.test/a.mp3",
        media: "media/a--1.mp3",
        status: "transcribed",
        files: EXTENSIONS.map((ext) => `transcripts/a--1${ext}`),
        language: "en",
        durationSec: 4,
        segments: 3,
      },
    ]);
    expect(await readFile(join(dir, "index.md"), "utf8")).toContain("3 segments, 4s");

    // A second run skips the finished transcript and keeps its details.
    const again = await runTranscribe({
      inputs: [dir],
      workers: 1,
      settings,
      runner: fakeRunner(),
    });
    expect(again.map((r) => r.status)).toEqual(["skipped"]);
    const resaved = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as Manifest;
    expect(resaved.transcripts?.[0]?.segments).toBe(3);
  });

  it("writes transcripts next to plain files and media found in folders", async () => {
    await mkdir(join(dir, "talks/nested"), { recursive: true });
    await writeFile(join(dir, "single.m4a"), "audio");
    await writeFile(join(dir, "talks/one.MP4"), "video");
    await writeFile(join(dir, "talks/nested/two.wav"), "audio");
    await writeFile(join(dir, "talks/notes.txt"), "not media");

    const seen: string[] = [];
    const results = await runTranscribe({
      inputs: [join(dir, "single.m4a"), join(dir, "talks")],
      workers: 3,
      settings,
      runner: fakeRunner(seen),
    });

    expect(results.every((r) => r.status === "transcribed")).toBe(true);
    expect(seen.toSorted()).toEqual(
      [
        join(dir, "single.m4a"),
        join(dir, "talks/nested/two.wav"),
        join(dir, "talks/one.MP4"),
      ].toSorted(),
    );
    expect(await readFile(join(dir, "talks/nested/two.txt"), "utf8")).toContain("two.wav");
    expect(await readFile(join(dir, "single.srt"), "utf8")).toContain("single.m4a");
  });

  it("fails clearly when there is nothing to transcribe", async () => {
    await writeFile(join(dir, "notes.txt"), "text");
    await expect(
      runTranscribe({ inputs: [dir], workers: 1, settings, runner: fakeRunner() }),
    ).rejects.toThrow("No audio or video files found to transcribe");
    await expect(
      runTranscribe({ inputs: [join(dir, "missing")], workers: 1, settings, runner: fakeRunner() }),
    ).rejects.toThrow("No such file or directory");
  });

  it("refuses to run whisper that is not installed", async () => {
    await writeFile(join(dir, "a.mp3"), "audio");
    await expect(runTranscribe({ inputs: [dir], workers: 1, settings })).rejects.toThrow(
      /Transcription is not set up/,
    );
  });
});

describe("threadsPerWorker", () => {
  it("splits the cores between workers, between 1 and 8 threads each", () => {
    expect(threadsPerWorker(2, 16)).toBe(8);
    expect(threadsPerWorker(4, 16)).toBe(4);
    expect(threadsPerWorker(1, 32)).toBe(8);
    expect(threadsPerWorker(8, 4)).toBe(1);
  });
});
