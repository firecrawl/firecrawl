import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { scrapePDFWithParsePDF } from "../pdfParse";

/**
 * Minimal valid PDF: one Helvetica text line per entry of each page's `lines`.
 * ASCII only, so xref offsets can be computed from string lengths. No fixtures
 * checked into the repo.
 */
function makePdf(pages: string[][]): Buffer {
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  const objects: [number, string][] = [
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`],
    [3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"],
  ];
  pages.forEach((lines, i) => {
    const pageId = 4 + i * 2;
    const contentId = pageId + 1;
    const ops = lines
      .map((line, j) => `${j === 0 ? "" : "0 -14 Td "}(${line}) Tj`)
      .join(" ");
    const content = `BT /F1 12 Tf 72 720 Td ${ops} ET`;
    objects.push([
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`,
    ]);
    objects.push([
      contentId,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    ]);
  });

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [id, body] of objects) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${body}\nendobj\n`;
  }
  const xrefPos = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= objects.length; id++) {
    out += `${offsets[id]}`.padStart(10, "0") + " 00000 n \n";
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  // Buffer.alloc never uses Node's shared Buffer pool, so the only pooled copy
  // of these bytes can be the one pdf.js makes (see skewBufferPool).
  const pdf = Buffer.alloc(out.length);
  pdf.write(out, "latin1");
  return pdf;
}

/**
 * pdf-parse's bundled pdf.js clones a Buffer input with `new Buffer(...)`,
 * which Node serves from its shared 8 KiB pool for anything under 4 KiB, and
 * then reads that slice's ArrayBuffer at absolute offsets. The parse only
 * succeeds by accident when the clone lands at the very start of a fresh pool,
 * so make sure the next pooled allocation of `size` bytes cannot.
 */
function skewBufferPool(size: number) {
  const probe = Buffer.allocUnsafe(8);
  const remaining = Buffer.poolSize - (probe.byteOffset + 8);
  if (remaining < size + 1024) {
    // Too little room left: roll over to a fresh pool now, leaving its first
    // bytes occupied so the clone starts at a non-zero offset.
    Buffer.allocUnsafe(remaining + 1);
  }
}

function makeMeta() {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const meta = {
    id: "pdf-parse-test",
    url: "https://example.com/file.pdf",
    logger,
  } as any;
  return { meta, logger };
}

describe("scrapePDFWithParsePDF", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "pdf-parse-test-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Regression: every PDF under ~4 KiB used to fail with "bad XRef entry".
  it("extracts text from a PDF smaller than 4 KiB", async () => {
    const pdf = makePdf([["Hello from a tiny PDF"]]);
    expect(pdf.length).toBeLessThan(4096);
    const filePath = path.join(dir, "small.pdf");
    writeFileSync(filePath, pdf);

    const { meta, logger } = makeMeta();
    skewBufferPool(pdf.length);
    const result = await scrapePDFWithParsePDF(meta, filePath);

    expect(result.markdown).toContain("Hello from a tiny PDF");
    expect(result.html).toContain("Hello from a tiny PDF");
    expect(logger.info).toHaveBeenCalledWith(
      "pdfParse succeeded",
      expect.objectContaining({ numPages: 1 }),
    );
  });

  it("extracts every page of a PDF larger than 4 KiB", async () => {
    const pages = Array.from({ length: 5 }, (_, p) =>
      Array.from(
        { length: 10 },
        (_, l) =>
          `The quick brown fox jumps over the lazy dog on page ${p + 1}, line ${l + 1}.`,
      ),
    );
    const pdf = makePdf(pages);
    expect(pdf.length).toBeGreaterThan(4096);
    const filePath = path.join(dir, "large.pdf");
    writeFileSync(filePath, pdf);

    const { meta, logger } = makeMeta();
    const result = await scrapePDFWithParsePDF(meta, filePath);

    for (let p = 1; p <= pages.length; p++) {
      expect(result.markdown).toContain(`on page ${p}, line 10.`);
    }
    expect(logger.info).toHaveBeenCalledWith(
      "pdfParse succeeded",
      expect.objectContaining({ numPages: pages.length }),
    );
  });

  it("rethrows and logs when the file is not a PDF", async () => {
    const filePath = path.join(dir, "not-a-pdf.pdf");
    writeFileSync(filePath, "<html><body>Not Found</body></html>");

    const { meta, logger } = makeMeta();
    await expect(scrapePDFWithParsePDF(meta, filePath)).rejects.toThrow();
    expect(logger.error).toHaveBeenCalledWith(
      "pdfParse failed",
      expect.objectContaining({ error: expect.anything() }),
    );
  });
});
