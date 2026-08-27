import { chunkByChars } from "./promptInjectionGuard";

describe("chunkByChars", () => {
  it("returns the whole text as a single chunk if within the limit", () => {
    expect(chunkByChars("hello world", 1000)).toEqual(["hello world"]);
  });

  it("returns an empty array for empty text", () => {
    expect(chunkByChars("", 10)).toEqual([]);
  });

  it("covers the entire input across chunks with no gaps or overlaps", () => {
    const text = "abcdefghij".repeat(1000);

    const chunks = chunkByChars(text, 37);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
  });

  it("keeps every chunk within the char limit", () => {
    const text = "x".repeat(10000);

    const chunks = chunkByChars(text, 300);

    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(300);
    }
  });

  it("stays fast on pathological low-entropy input", () => {
    const huge = "A".repeat(10_000_000);

    const start = Date.now();
    chunkByChars(huge, 100000);
    const durationMs = Date.now() - start;

    expect(durationMs).toBeLessThan(1000);
  });

  it("keeps a marker straddling a chunk boundary intact in at least one chunk", () => {
    const maxCharsPerChunk = 100;
    const overlap = 20;
    const marker = "INJECT-THIS-PHRASE";
    // Placed to straddle the boundary between the first and second chunk.
    const text =
      "x".repeat(maxCharsPerChunk - 5) + marker + "y".repeat(500);

    const chunks = chunkByChars(text, maxCharsPerChunk, overlap);

    expect(chunks.some(c => c.includes(marker))).toBe(true);
  });

  it("still respects the char limit per chunk when overlapping", () => {
    const text = "x".repeat(10000);

    const chunks = chunkByChars(text, 300, 50);

    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(300);
    }
    expect(chunks.join("").length).toBeGreaterThanOrEqual(text.length);
  });
});
