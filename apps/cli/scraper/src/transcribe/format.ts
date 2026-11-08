export interface Segment {
  /** Seconds from the start of the media. */
  start: number;
  end: number;
  text: string;
}

export interface Transcript {
  language: string | undefined;
  segments: Segment[];
}

interface WhisperJson {
  result?: { language?: string };
  transcription?: Array<{ offsets?: { from?: number; to?: number }; text?: string }>;
}

/** Read whisper.cpp's `-oj`/`-ojf` JSON (offsets are milliseconds). */
export function parseWhisperJson(raw: string): Transcript {
  const json = JSON.parse(raw) as WhisperJson;
  const segments = (json.transcription ?? [])
    .map((item) => ({
      start: (item.offsets?.from ?? 0) / 1000,
      end: (item.offsets?.to ?? 0) / 1000,
      text: (item.text ?? "").trim(),
    }))
    .filter((segment) => segment.text.length > 0);
  return { language: json.result?.language, segments };
}

const pad = (value: number, width = 2): string => String(value).padStart(width, "0");

/** `HH:MM:SS.mmm`, e.g. 83.45 → `00:01:23.450`. */
export function formatTimestamp(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  return `${pad(Math.floor(totalSeconds / 3600))}:${pad(Math.floor(totalSeconds / 60) % 60)}:${pad(totalSeconds % 60)}.${pad(ms, 3)}`;
}

/** One `[start → end] text` line per segment. */
export function transcriptText(transcript: Transcript): string {
  return transcript.segments
    .map((s) => `[${formatTimestamp(s.start)} → ${formatTimestamp(s.end)}] ${s.text}\n`)
    .join("");
}
