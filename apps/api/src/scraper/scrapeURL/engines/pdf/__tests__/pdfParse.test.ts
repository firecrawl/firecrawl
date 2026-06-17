import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Minimal valid PDF (one page, Helvetica, single text-showing operator). We
// hand-craft one in the test rather than depending on test/data shipped by an
// external package — that's exactly the sort of internal layout that broke in
// production (pdf-parse's bundled pdf.js binary went missing from the docker
// image, MODULE_NOT_FOUND, no working last-resort PDF engine).
function buildMinimalPdf(text: string): Buffer {
  const enc = (s: string) => Buffer.from(s, "binary");
  const header = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const obj1 = "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n";
  const obj2 = "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n";
  const obj3 =
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
    "/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n";
  const obj4 =
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n";
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET\n`;
  const obj5 = `5 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}endstream\nendobj\n`;

  const parts = [header, obj1, obj2, obj3, obj4, obj5];
  const offsets: number[] = [];
  let cursor = 0;
  for (const p of parts) {
    offsets.push(cursor);
    cursor += enc(p).length;
  }
  const pad = (n: number) => n.toString().padStart(10, "0");
  let xref = "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i++) xref += `${pad(offsets[i])} 00000 n \n`;
  const trailer = "trailer\n<< /Size 6 /Root 1 0 R >>\n";
  const startxrefStr = `startxref\n${cursor}\n%%EOF\n`;

  return Buffer.concat([
    ...parts.map(enc),
    enc(xref),
    enc(trailer),
    enc(startxrefStr),
  ]);
}

// pdfjs-dist is ESM-only and uses `import.meta.url`, so we can't load it
// inside jest's CJS runtime. Run the actual extraction in a fresh `tsx` child
// process — that's the configuration production uses anyway. Result is passed
// via a tmp file because pdfjs prints unrelated warnings to stdout.
function runExtractor(
  pdfPath: string,
  outPath: string,
): { ok: true; markdown: string } | { ok: false; error: string } {
  const apiRoot = resolve(__dirname, "../../../../../..");
  const stub = `
    const fs = require('node:fs');
    const { scrapePDFWithParsePDF } = require('${apiRoot}/src/scraper/scrapeURL/engines/pdf/pdfParse.ts');
    const meta = { logger: { debug() {}, info() {}, warn() {}, error() {} } };
    const [pdfPath, outPath] = process.argv.slice(1);
    scrapePDFWithParsePDF(meta, pdfPath).then(
      r => fs.writeFileSync(outPath, JSON.stringify({ ok: true, ...r })),
      e => {
        fs.writeFileSync(outPath, JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
        process.exit(1);
      }
    );
  `;
  try {
    execFileSync(
      "node",
      [
        "--import",
        "tsx",
        "--input-type=commonjs",
        "-e",
        stub,
        pdfPath,
        outPath,
      ],
      {
        cwd: apiRoot,
        encoding: "utf8",
        stdio: "ignore",
        timeout: 30_000,
      },
    );
  } catch {
    // Failed exit — outPath should still contain the failure payload.
  }
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    return JSON.parse(fs.readFileSync(outPath, "utf8"));
  } catch {
    return { ok: false, error: "no output written" };
  }
}

describe("scrapePDFWithParsePDF", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "pdfparse-test-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("extracts text from a small valid PDF", async () => {
    const pdfPath = join(tmp, "valid.pdf");
    const outPath = join(tmp, "valid.out.json");
    await writeFile(pdfPath, buildMinimalPdf("Hello, regression!"));

    const result = runExtractor(pdfPath, outPath);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.markdown).toContain("Hello, regression!");
    }
  }, 60_000);

  it("HTML-escapes characters that would otherwise be interpreted as markup", async () => {
    const pdfPath = join(tmp, "escape.pdf");
    const outPath = join(tmp, "escape.out.json");
    await writeFile(pdfPath, buildMinimalPdf("<script>alert(1)</script>"));

    const result = runExtractor(pdfPath, outPath);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.markdown).not.toContain("<script>");
      expect(result.markdown).toContain("&lt;script&gt;");
    }
  }, 60_000);

  it("rejects non-PDF input", async () => {
    const garbagePath = join(tmp, "garbage.pdf");
    const outPath = join(tmp, "garbage.out.json");
    await writeFile(garbagePath, "this is definitely not a pdf");

    const result = runExtractor(garbagePath, outPath);

    expect(result.ok).toBe(false);
  }, 60_000);
});
