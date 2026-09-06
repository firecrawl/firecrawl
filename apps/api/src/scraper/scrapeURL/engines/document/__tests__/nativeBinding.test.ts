import { convertDocumentToMarkdown } from "@mendable/firecrawl-rs";

/**
 * Tests for the native (Rust) document binding's interaction with the Node
 * event loop. Regression: convertDocumentToMarkdown used to be a synchronous
 * napi call — a large DOCX/RTF/XLSX conversion would freeze the event loop of
 * whichever pod executed the scrape (including API app pods running sync
 * scrapes in-process), failing liveness probes and timing out every unrelated
 * in-flight request on the process. It must run off the main thread (tokio
 * spawn_blocking), same as processPdf/detectPdf.
 */

/** Minimal RTF writer — no fixtures checked into the repo. */
function makeRtf(paragraphs: number): Buffer {
  const parts = ["{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Times New Roman;}}"];
  for (let i = 0; i < paragraphs; i++) {
    parts.push(
      `\\pard {\\b Heading ${i}} \\par The quick brown fox jumps over the lazy dog. {\\i Pack my box} with five dozen liquor jugs. Paragraph ${i}. \\par`,
    );
  }
  parts.push("}");
  return Buffer.from(parts.join("\n"), "latin1");
}

describe("native document binding", () => {
  it("converts a document to markdown", async () => {
    const markdown = await convertDocumentToMarkdown(
      new Uint8Array(makeRtf(1)),
    );
    expect(markdown).toContain("quick brown fox");
    expect(markdown).toContain("**Heading 0**");
  });

  it("does not block the event loop during large conversions", async () => {
    // Big enough that conversion takes ~1s of CPU: with the old synchronous
    // binding the event loop would be frozen for that entire time.
    const heavyRtf = makeRtf(100000);

    let maxLag = 0;
    let last = Date.now();
    const interval = setInterval(() => {
      const now = Date.now();
      maxLag = Math.max(maxLag, now - last - 50);
      last = now;
    }, 50);

    try {
      const markdown = await convertDocumentToMarkdown(
        new Uint8Array(heavyRtf),
      );
      expect(markdown).toContain("Paragraph 99999");
    } finally {
      // Let any overdue interval tick fire before clearing: the await
      // continuation is a microtask and would otherwise beat the timer,
      // hiding the lag a synchronous binding would have caused.
      await new Promise(resolve => setTimeout(resolve, 100));
      clearInterval(interval);
    }

    // Synchronous binding: lag ~= full conversion time (~1s+ for this file).
    expect(maxLag).toBeLessThan(250);
  }, 30000);
});
