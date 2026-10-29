// Markdown-aware chunker for fire-privacy /redact.
//
// Splits a long markdown document into pieces small enough to fit
// fire-privacy's request cap (100KB / model truncation @ 32K chars),
// preferring "safe" split points so PII spans rarely straddle chunks.
//
// Split priority (latest match wins inside the upper half of the window):
//   1. paragraph break (\n\n)  -- best
//   2. line break      (\n)
//   3. sentence end    ([.!?]\s)
//   4. whitespace
//   5. hard cut                -- only if none of the above appear
//
// Chunks are non-overlapping; concatenating their `text` reproduces the
// input character-for-character. Each chunk carries its start offset
// so the caller can lift per-chunk spans into the source coordinate
// space when merging.

export type Chunk = {
  text: string;
  start: number;
};

// Leave headroom below fire-privacy's `model_max_input_chars` (32K) so
// boundary search can walk backwards to a real paragraph break.
export const DEFAULT_MAX_CHARS = 28_000;
// Leave headroom below fire-privacy's `max_text_bytes` (100K). UTF-8
// markdown is typically ~1 byte/char but non-ASCII spikes can push past;
// we re-validate the per-chunk byte count and shrink if needed.
const DEFAULT_MAX_BYTES = 95_000;

const SENTENCE_END = /[.!?]\s/g;

// Find the latest "safe" index in text[lo..hi] to split, or `hi` if no
// safe boundary is found (caller may hard-cut at `hi`).
function findSafeSplit(text: string, lo: number, hi: number): number {
  const window = text.slice(lo, hi);

  const para = window.lastIndexOf("\n\n");
  if (para > 0) return lo + para + 2;

  const line = window.lastIndexOf("\n");
  if (line > 0) return lo + line + 1;

  // Walk the regex to find the LAST [.!?]\s in the window.
  SENTENCE_END.lastIndex = 0;
  let lastSentenceEnd = -1;
  let match: RegExpExecArray | null;
  while ((match = SENTENCE_END.exec(window)) !== null) {
    lastSentenceEnd = match.index + match[0].length;
  }
  if (lastSentenceEnd > 0) return lo + lastSentenceEnd;

  const space = window.lastIndexOf(" ");
  if (space > 0) return lo + space + 1;

  return hi;
}

function utf8ByteLength(s: string): number {
  // TextEncoder is faster than Buffer.byteLength for large strings in V8
  // and avoids a Buffer allocation per call.
  return new TextEncoder().encode(s).length;
}

type ChunkOptions = {
  maxChars?: number;
  maxBytes?: number;
};

export function chunkMarkdown(text: string, opts?: ChunkOptions): Chunk[] {
  if (text.length === 0) return [];
  const maxChars = opts?.maxChars ?? DEFAULT_MAX_CHARS;
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  // Guard against caller bugs that would otherwise leave the cursor parked
  // at 0 (maxChars ≤ 0 → tentativeEnd ≤ cursor) and spin forever.
  if (maxChars <= 0) {
    throw new RangeError(
      `chunkMarkdown: maxChars must be > 0 (got ${maxChars})`,
    );
  }
  if (maxBytes <= 0) {
    throw new RangeError(
      `chunkMarkdown: maxBytes must be > 0 (got ${maxBytes})`,
    );
  }

  const chunks: Chunk[] = [];
  const n = text.length;
  let cursor = 0;

  while (cursor < n) {
    const tentativeEnd = Math.min(cursor + maxChars, n);

    let safeEnd: number;
    if (tentativeEnd === n) {
      // Whole remainder fits within maxChars — single tail chunk.
      safeEnd = n;
    } else {
      // Constrain the safe-split search to the upper half of the window —
      // prevents pathological cases where the only paragraph break is
      // near the chunk's start and would produce a tiny chunk.
      const lo = cursor + Math.floor(maxChars / 2);
      safeEnd = findSafeSplit(text, lo, tentativeEnd);
      if (safeEnd <= cursor) safeEnd = tentativeEnd;
    }

    let chunkText = text.slice(cursor, safeEnd);

    // Byte-budget enforcement for non-ASCII text. Rare on web markdown
    // but cheap to handle: shrink one char at a time. Done as a `while`
    // because each removed char may straddle a multibyte boundary.
    if (utf8ByteLength(chunkText) > maxBytes) {
      while (utf8ByteLength(chunkText) > maxBytes && chunkText.length > 1) {
        chunkText = chunkText.slice(0, -1);
      }
      safeEnd = cursor + chunkText.length;
    }

    chunks.push({ text: chunkText, start: cursor });
    cursor = safeEnd;
  }

  return chunks;
}
