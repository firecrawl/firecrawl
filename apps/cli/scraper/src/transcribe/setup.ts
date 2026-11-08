import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.js";

export const WHISPER_VERSION = "v1.9.5";
export const DEFAULT_MODEL = "ggml-large-v3-turbo-q5_0.bin";

/** Where the in-app installer puts whisper.cpp and its models. */
export function whisperHome(env: NodeJS.ProcessEnv = process.env): string {
  return env["FIRESCRAPE_WHISPER_HOME"] ?? join(homedir(), ".local/share/firescrape");
}

export interface WhisperPaths {
  bin: string;
  model: string;
}

export interface WhisperStatus extends WhisperPaths {
  binFound: boolean;
  modelFound: boolean;
  ready: boolean;
}

/** Binary: config, then WHISPER_CLI, then the install location. Model: config, then the default. */
export function resolveWhisper(
  config: Pick<Config, "transcribe">,
  overrides: { model?: string | undefined } = {},
  env: NodeJS.ProcessEnv = process.env,
): WhisperPaths {
  const home = whisperHome(env);
  return {
    bin:
      config.transcribe?.whisperBin ??
      env["WHISPER_CLI"] ??
      join(home, "whisper.cpp/build/bin/whisper-cli"),
    model: overrides.model ?? config.transcribe?.model ?? join(home, "models", DEFAULT_MODEL),
  };
}

export function whisperStatus(paths: WhisperPaths): WhisperStatus {
  const binFound = existsSync(paths.bin);
  const modelFound = existsSync(paths.model);
  return { ...paths, binFound, modelFound, ready: binFound && modelFound };
}

export function assertWhisperReady(paths: WhisperPaths): void {
  const status = whisperStatus(paths);
  const missing = [
    ...(status.binFound ? [] : [`whisper-cli (${paths.bin})`]),
    ...(status.modelFound ? [] : [`model (${paths.model})`]),
  ];
  if (missing.length > 0)
    throw new Error(
      `Transcription is not set up; missing ${missing.join(" and ")}. ` +
        'Run `task scraper` and choose "Set up transcription".',
    );
}
