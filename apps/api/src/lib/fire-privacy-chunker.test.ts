import { chunkMarkdown, DEFAULT_MAX_CHARS } from "./fire-privacy-chunker";

describe("chunkMarkdown", () => {
  it("returns a single chunk for short input", () => {
    const text = "Hello world.\n\nThis is short.";
    const chunks = chunkMarkdown(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe(text);
    expect(chunks[0].start).toBe(0);
  });

  it("returns empty array for empty input", () => {
    expect(chunkMarkdown("")).toEqual([]);
  });

  it("preserves exact content across all chunks (concat=identity)", () => {
    const para = "Sentence one. Sentence two. Sentence three.\n\n";
    const text = para.repeat(2000); // ~88KB — forces multiple chunks
    const chunks = chunkMarkdown(text);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map(c => c.text).join("")).toBe(text);
    // Start offsets line up with cumulative chunk lengths
    let cursor = 0;
    for (const c of chunks) {
      expect(c.start).toBe(cursor);
      cursor += c.text.length;
    }
  });

  it("never exceeds maxChars per chunk", () => {
    const text = "x".repeat(100_000); // no natural break points
    const chunks = chunkMarkdown(text, { maxChars: 1_000 });
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(1_000);
    }
  });

  it("splits at paragraph boundaries when available", () => {
    // Two ~20K-char paragraphs separated by \n\n. With maxChars=28K, the
    // first chunk should end at the paragraph break, not partway through
    // either paragraph.
    const para1 = "A".repeat(20_000);
    const para2 = "B".repeat(20_000);
    const text = `${para1}\n\n${para2}`;
    const chunks = chunkMarkdown(text, { maxChars: 28_000 });

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // First chunk ends at the paragraph break — its tail should be the
    // two newlines, and the next chunk should start with 'B'.
    expect(chunks[0].text.endsWith("\n\n")).toBe(true);
    expect(chunks[1].text.startsWith("B")).toBe(true);
  });

  it("falls back to sentence boundary when no paragraph break is in range", () => {
    const sentence = "X".repeat(99) + ". ";
    const text = sentence.repeat(300); // ~30K, no \n
    const chunks = chunkMarkdown(text, { maxChars: 10_000 });

    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 0; i < chunks.length - 1; i++) {
      // Each non-final chunk should end at ". " (sentence end + space)
      expect(/[.!?]\s$/.test(chunks[i].text)).toBe(true);
    }
  });

  it("hard-cuts when no safe boundary exists in the upper half", () => {
    // Single 50K-char run with no whitespace or punctuation.
    const text = "z".repeat(50_000);
    const chunks = chunkMarkdown(text, { maxChars: 10_000 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map(c => c.text).join("")).toBe(text);
  });

  it("enforces maxBytes for non-ASCII input", () => {
    // Emoji = 4 bytes each in UTF-8. 1000 emoji = 4000 bytes, 1000 chars.
    const text = "🔒".repeat(1000);
    const chunks = chunkMarkdown(text, { maxChars: 10_000, maxBytes: 1_000 });
    for (const c of chunks) {
      expect(new TextEncoder().encode(c.text).length).toBeLessThanOrEqual(
        1_000,
      );
    }
    expect(chunks.map(c => c.text).join("")).toBe(text);
  });

  it("uses sensible default for max chunk size", () => {
    // Default should leave headroom below fire-privacy's 32K model window.
    expect(DEFAULT_MAX_CHARS).toBeLessThan(32_000);
    expect(DEFAULT_MAX_CHARS).toBeGreaterThanOrEqual(20_000);
  });

  it("rejects non-positive maxChars (would otherwise infinite-loop)", () => {
    expect(() => chunkMarkdown("abc", { maxChars: 0 })).toThrow(RangeError);
    expect(() => chunkMarkdown("abc", { maxChars: -1 })).toThrow(RangeError);
  });

  it("rejects non-positive maxBytes", () => {
    expect(() => chunkMarkdown("abc", { maxBytes: 0 })).toThrow(RangeError);
    expect(() => chunkMarkdown("abc", { maxBytes: -10 })).toThrow(RangeError);
  });
});
