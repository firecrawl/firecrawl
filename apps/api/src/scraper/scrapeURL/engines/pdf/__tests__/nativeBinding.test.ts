import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { processPdf, detectPdf } from "@mendable/firecrawl-rs";

/**
 * Tests for the native (Rust) PDF binding's interaction with the Node event
 * loop. Regression: processPdf/detectPdf used to be synchronous napi calls —
 * a 181-page complex PDF once blocked an app pod's event loop for ~25s,
 * failing liveness probes and timing out every unrelated in-flight scrape on
 * the process. They must run off the main thread (tokio spawn_blocking).
 */

/** Minimal valid PDF writer — no fixtures checked into the repo. */
function makePdf(pages: number, linesPerPage: number): Buffer {
  const kids: string[] = [];
  const objects: [number, string][] = [];
  let nextId = 4;

  for (let i = 0; i < pages; i++) {
    const pageId = nextId;
    const contentId = nextId + 1;
    nextId += 2;
    kids.push(`${pageId} 0 R`);
    // NB: keep the page/line numbers at the END of the sentence — a leading
    // "Page N line M:" prefix trips the extractor's header/boilerplate filter
    // and the line gets dropped.
    const lines: string[] = [
      `(The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. Page ${i + 1}, line 0.) Tj`,
    ];
    for (let j = 1; j < linesPerPage; j++) {
      lines.push(
        `0 -14 Td (The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. Page ${i + 1}, line ${j}.) Tj`,
      );
    }
    const text = `BT /F1 12 Tf 72 720 Td ${lines.join(" ")} ET`;
    objects.push([
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`,
    ]);
    objects.push([
      contentId,
      `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    ]);
  }

  objects.unshift(
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages} >>`],
    [3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"],
  );
  objects.sort((a, b) => a[0] - b[0]);

  let out = "%PDF-1.4\n";
  const offsets = new Map<number, number>();
  for (const [id, body] of objects) {
    offsets.set(id, out.length);
    out += `${id} 0 obj\n${body}\nendobj\n`;
  }
  const xrefPos = out.length;
  const maxId = nextId - 1;
  out += `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maxId; id++) {
    out += `${offsets.get(id)}`.padStart(10, "0") + " 00000 n \n";
  }
  out += `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

describe("native PDF binding", () => {
  let dir: string;
  let smallPdf: string;
  let heavyPdf: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "firecrawl-native-pdf-"));
    smallPdf = path.join(dir, "small.pdf");
    heavyPdf = path.join(dir, "heavy.pdf");
    writeFileSync(smallPdf, makePdf(1, 1));
    // Big enough that extraction takes ~1s of CPU: with the old synchronous
    // binding the event loop would be frozen for that entire time.
    writeFileSync(heavyPdf, makePdf(2000, 50));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("detectPdf returns metadata", async () => {
    const result = await detectPdf(smallPdf, {
      scrapeId: "test",
      url: "file://small.pdf",
    });
    expect(result.pageCount).toBe(1);
    expect(result.pdfType).toBe("TextBased");
  });

  it("processPdf extracts markdown and native logs", async () => {
    const result = await processPdf(smallPdf, null, {
      scrapeId: "test",
      url: "file://small.pdf",
    });
    expect(result.pageCount).toBe(1);
    expect(result.markdown).toContain("quick brown fox");
    expect(result.logs.map(l => l.message)).toContain(
      "starting PDF processing",
    );
  });

  it("does not block the event loop during large extractions", async () => {
    let maxLag = 0;
    let last = Date.now();
    const interval = setInterval(() => {
      const now = Date.now();
      maxLag = Math.max(maxLag, now - last - 50);
      last = now;
    }, 50);

    try {
      const result = await processPdf(heavyPdf, null, {
        scrapeId: "test",
        url: "file://heavy.pdf",
      });
      expect(result.pageCount).toBe(2000);
    } finally {
      // Let any overdue interval tick fire before clearing: the await
      // continuation is a microtask and would otherwise beat the timer,
      // hiding the lag a synchronous binding would have caused.
      await new Promise(resolve => setTimeout(resolve, 100));
      clearInterval(interval);
    }

    // Synchronous binding: lag ~= full extraction time (~1s+ for this file).
    expect(maxLag).toBeLessThan(250);
  });
});
