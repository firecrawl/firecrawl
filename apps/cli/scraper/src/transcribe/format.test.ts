import { describe, expect, it } from "vitest";
import { formatTimestamp, parseWhisperJson, transcriptText } from "./format.js";

describe("transcript formatting", () => {
  it("formats timestamps with hours and milliseconds", () => {
    expect(formatTimestamp(0)).toBe("00:00:00.000");
    expect(formatTimestamp(83.45)).toBe("00:01:23.450");
    expect(formatTimestamp(3_725.0006)).toBe("01:02:05.001");
    expect(formatTimestamp(59.9996)).toBe("00:01:00.000");
    expect(formatTimestamp(-1)).toBe("00:00:00.000");
  });

  it("reads whisper.cpp JSON offsets as seconds and drops empty segments", () => {
    const transcript = parseWhisperJson(
      JSON.stringify({
        result: { language: "en" },
        transcription: [
          { offsets: { from: 0, to: 2_500 }, text: " Hello there." },
          { offsets: { from: 2_500, to: 2_600 }, text: "  " },
          { offsets: { from: 61_000, to: 64_250 }, text: " Part one." },
        ],
      }),
    );
    expect(transcript).toEqual({
      language: "en",
      segments: [
        { start: 0, end: 2.5, text: "Hello there." },
        { start: 61, end: 64.25, text: "Part one." },
      ],
    });
    expect(transcriptText(transcript)).toBe(
      "[00:00:00.000 → 00:00:02.500] Hello there.\n[00:01:01.000 → 00:01:04.250] Part one.\n",
    );
  });
});
