import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ffmpegArgs,
  isTranscribed,
  transcribeFile,
  whisperArgs,
  whisperProgress,
  type TranscribeSettings,
} from "./transcribe.js";

const settings: TranscribeSettings = {
  whisper: { bin: "/opt/whisper-cli", model: "/opt/model.bin" },
  language: "auto",
  threads: 4,
  gpu: true,
};

function hasFfmpeg(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("transcription commands", () => {
  it("converts input to 16 kHz mono PCM without video", () => {
    expect(ffmpegArgs("in.mp4", "out.wav")).toEqual(
      expect.arrayContaining(["-i", "in.mp4", "-vn", "-ar", "16000", "-ac", "1", "out.wav"]),
    );
  });

  it("asks whisper for timestamped SRT, VTT and full JSON", () => {
    expect(whisperArgs(settings, "a.wav", "/out/clip")).toEqual([
      "-m",
      "/opt/model.bin",
      "-f",
      "a.wav",
      "-l",
      "auto",
      "-t",
      "4",
      "-pp",
      "-osrt",
      "-ovtt",
      "-ojf",
      "-of",
      "/out/clip",
    ]);
    expect(whisperArgs({ ...settings, gpu: false }, "a.wav", "b")).toContain("-ng");
  });

  it("parses whisper progress lines", () => {
    expect(whisperProgress("whisper_print_progress_callback: progress =  45%")).toBe(45);
    expect(whisperProgress("whisper_full: something else")).toBeUndefined();
  });
});

describe.runIf(hasFfmpeg())("transcribeFile with a fake whisper", () => {
  let dir = "";
  let fakeWhisper = "";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "transcribe-test-"));
    fakeWhisper = join(dir, "fake-whisper.mjs");
    // Mimics whisper-cli: progress on stderr, outputs at `-of <base>`.
    await writeFile(
      fakeWhisper,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
const base = args[args.indexOf("-of") + 1];
const { writeFileSync } = await import("node:fs");
process.stderr.write("whisper_print_progress_callback: progress =  50%\\n");
writeFileSync(base + ".srt", "1\\n00:00:00,000 --> 00:00:01,500\\nHello\\n");
writeFileSync(base + ".vtt", "WEBVTT\\n");
writeFileSync(base + ".json", JSON.stringify({ result: { language: "en" },
  transcription: [{ offsets: { from: 0, to: 1500 }, text: " Hello" }] }));
`,
    );
    await chmod(fakeWhisper, 0o755);
    execFileSync("ffmpeg", [
      "-nostdin",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=2",
      join(dir, "tone.mp3"),
    ]);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes timestamped outputs and reports duration and progress", async () => {
    const base = join(dir, "out", "tone");
    const progress: number[] = [];
    const output = await transcribeFile(
      join(dir, "tone.mp3"),
      base,
      { ...settings, whisper: { bin: fakeWhisper, model: "unused" } },
      (p) => progress.push(p),
    );
    expect(output.language).toBe("en");
    expect(output.segments).toBe(1);
    expect(output.durationSec).toBeGreaterThan(1.9);
    expect(output.durationSec).toBeLessThan(2.2);
    expect(output.files).toEqual([".srt", ".vtt", ".json", ".txt"].map((e) => base + e));
    expect(await readFile(`${base}.txt`, "utf8")).toBe("[00:00:00.000 → 00:00:01.500] Hello\n");
    expect(progress).toEqual([0, 50, 100]);
    expect(isTranscribed(base)).toBe(true);
  });

  it("refuses playlists disguised as media", async () => {
    const evil = join(dir, "evil.mp3");
    await writeFile(evil, "ffconcat version 1.0\nfile /etc/hostname\n");
    await expect(
      transcribeFile(evil, join(dir, "evil"), {
        ...settings,
        whisper: { bin: fakeWhisper, model: "unused" },
      }),
    ).rejects.toThrow(/whitelist/);
  });

  it("reports a missing whisper binary", async () => {
    await expect(
      transcribeFile(join(dir, "tone.mp3"), join(dir, "x"), {
        ...settings,
        whisper: { bin: join(dir, "nope"), model: "unused" },
      }),
    ).rejects.toThrow(/not found/);
  });
});
