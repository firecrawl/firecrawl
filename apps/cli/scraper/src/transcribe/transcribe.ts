import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runProcess } from "../lib/run-process.js";
import { parseWhisperJson, transcriptText } from "./format.js";
import type { WhisperPaths } from "./setup.js";

export interface TranscribeSettings {
  whisper: WhisperPaths;
  /** ISO 639-1 code, or "auto" to detect. */
  language: string;
  /** CPU threads per whisper process. */
  threads: number;
  /** false runs whisper on the CPU (`-ng`). */
  gpu: boolean;
}

export interface TranscribeOutput {
  /** Output paths, without the shared base: `.srt`, `.vtt`, `.json`, `.txt`. */
  files: string[];
  language: string | undefined;
  durationSec: number;
  segments: number;
}

export const TRANSCRIPT_EXTENSIONS = [".srt", ".vtt", ".json", ".txt"] as const;

const WAV_BYTES_PER_SECOND = 16_000 * 2;
const WAV_HEADER_BYTES = 44;

/**
 * Demuxers for ordinary audio/video files. Downloaded media is untrusted, and
 * ffmpeg probes by content, so a playlist (HLS, ffconcat) disguised as `.mp3`
 * could otherwise make it fetch URLs or read other local files.
 */
const INPUT_FORMATS = "mp3,mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,ogg,wav,flac,aac,avi";

export function ffmpegArgs(input: string, wav: string): string[] {
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-protocol_whitelist",
    "file",
    "-format_whitelist",
    INPUT_FORMATS,
    "-i",
    input,
    "-vn",
    "-ar",
    "16000",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    wav,
  ];
}

export function whisperArgs(settings: TranscribeSettings, wav: string, base: string): string[] {
  return [
    "-m",
    settings.whisper.model,
    "-f",
    wav,
    "-l",
    settings.language,
    "-t",
    String(settings.threads),
    "-pp",
    "-osrt",
    "-ovtt",
    "-ojf",
    "-of",
    base,
    ...(settings.gpu ? [] : ["-ng"]),
  ];
}

/** Parse whisper.cpp's `-pp` output, e.g. `... progress =  45%`. */
export function whisperProgress(line: string): number | undefined {
  const match = /progress\s*=\s*(\d{1,3})%/.exec(line);
  return match ? Math.min(100, Number(match[1])) : undefined;
}

/** The `.txt` is written last, so its presence marks a finished transcript. */
export function isTranscribed(base: string): boolean {
  return existsSync(`${base}.txt`);
}

/**
 * Transcribe one audio or video file to `<base>.{srt,vtt,json,txt}`. Every
 * output carries segment timestamps; the `.txt` reads `[start → end] text`.
 */
export async function transcribeFile(
  input: string,
  base: string,
  settings: TranscribeSettings,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal,
): Promise<TranscribeOutput> {
  await mkdir(dirname(base), { recursive: true });
  const scratch = await mkdtemp(join(tmpdir(), "scraper-transcribe-"));
  try {
    const wav = join(scratch, "audio.wav");
    await runProcess("ffmpeg", ffmpegArgs(input, wav), { signal });
    const durationSec = Math.max(
      0,
      ((await stat(wav)).size - WAV_HEADER_BYTES) / WAV_BYTES_PER_SECOND,
    );
    onProgress?.(0);
    await runProcess(settings.whisper.bin, whisperArgs(settings, wav, base), {
      signal,
      onLine: (line) => {
        const percent = whisperProgress(line);
        if (percent !== undefined) onProgress?.(percent);
      },
    });
    const transcript = parseWhisperJson(await readFile(`${base}.json`, "utf8"));
    await writeFile(`${base}.txt`, transcriptText(transcript));
    onProgress?.(100);
    return {
      files: TRANSCRIPT_EXTENSIONS.map((ext) => `${base}${ext}`),
      language: transcript.language,
      durationSec: Math.round(durationSec * 1000) / 1000,
      segments: transcript.segments.length,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
