// Heuristics for detecting a broken or garbled embedded PDF text layer.
//
// Some PDFs (commonly CJK documents) carry an embedded text layer whose font
// has a missing or broken `ToUnicode` CMap. The fast text extractor still
// produces a string that isn't empty for these, but the glyphs map to
// mojibake (U+FFFD replacement characters, Private Use Area codepoints, or
// control bytes) rather than real characters. Auto mode treats any output that
// isn't empty as a successful extraction, so the OCR fallback that would
// recover the text never runs. These helpers give auto mode a quality signal
// in addition to quantity.

/**
 * Returns the fraction (0..1) of "suspect" characters in the input.
 * High values indicate a broken/garbled text layer (e.g. bad ToUnicode CMap).
 *
 * Ordinary whitespace is excluded from the denominator so that layout
 * whitespace doesn't dilute the ratio.
 */
export function garbledTextRatio(text: string): number {
  if (!text) return 0;

  let suspect = 0;
  let counted = 0;

  for (const ch of text) {
    // Iterates by code point rather than by code unit.
    const cp = ch.codePointAt(0)!;

    // Skip ordinary whitespace from the denominator.
    if (cp === 0x09 || cp === 0x0a || cp === 0x0d || cp === 0x20) continue;
    counted++;

    const isReplacement = cp === 0xfffd; // �
    const isPUA =
      (cp >= 0xe000 && cp <= 0xf8ff) || // BMP PUA
      (cp >= 0xf0000 && cp <= 0xffffd) || // Plane 15
      (cp >= 0x100000 && cp <= 0x10fffd); // Plane 16
    const isControl =
      (cp <= 0x1f && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) || // C0
      (cp >= 0x7f && cp <= 0x9f); // DEL + C1

    if (isReplacement || isPUA || isControl) suspect++;
  }

  return counted === 0 ? 0 : suspect / counted;
}

// Conservative: only flag when garbling is clearly dominant, to avoid
// regressing clean PDFs (OCR is slower and costlier). Tuned high so that
// legitimately symbol heavy PDFs (math, emoji, dingbats) don't trip the gate.
export const GARBLED_TEXT_THRESHOLD = 0.3;

/**
 * Returns true when the extracted text looks like a broken text layer rather
 * than real content, based on the ratio of suspect codepoints.
 */
export function isLikelyGarbled(
  text: string,
  threshold = GARBLED_TEXT_THRESHOLD,
): boolean {
  return garbledTextRatio(text) >= threshold;
}
