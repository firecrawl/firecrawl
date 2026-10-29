import { readFileSync } from "node:fs";
import path from "node:path";
import { describeIf } from "../lib";
import { config } from "../../../config";
import { idmux, Identity, parse, parseWithFailure, scrapeTimeout } from "./lib";

function fixture(name: string) {
  return {
    content: readFileSync(path.join(__dirname, "..", "fixtures", name)),
    filename: name,
    contentType: "application/pdf",
  };
}

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "parse-fire-pdf",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000 + scrapeTimeout);

const FIRE_PDF_ON =
  !process.env.TEST_SUITE_SELF_HOSTED &&
  !!config.FIRE_PDF_BASE_URL &&
  !!config.FIRE_PDF_ENABLE &&
  config.PARSE_PDF_ALWAYS_FIRE_PDF;

describeIf(FIRE_PDF_ON)("/v2/parse sends PDFs to FirePDF", () => {
  it.concurrent(
    "serves a simple text PDF from FirePDF, not direct extraction",
    async () => {
      const file = fixture("parse-text.pdf");
      const [plain, forced] = await Promise.all([
        parse({ options: { formats: ["markdown"] }, file }, identity),
        parse(
          {
            options: {
              formats: ["markdown"],
              parsers: [{ type: "pdf", blocks: true }],
            },
            file,
          },
          identity,
        ),
      ]);

      expect(plain.markdown).toContain("Quarterly Field Notes");
      expect(plain.markdown).toContain("Migratory birds");
      // Blocks always run FirePDF and leave the document markdown as is, so
      // a default parse served by FirePDF returns the same markdown.
      expect(plain.markdown).toBe(forced.markdown);
      expect(plain.metadata.numPages).toBe(1);
    },
    scrapeTimeout * 2,
  );

  it.concurrent(
    "OCRs a scanned PDF in auto mode",
    async () => {
      const result = await parse(
        {
          options: { formats: ["markdown"] },
          file: fixture("parse-scanned.pdf"),
        },
        identity,
      );

      expect(result.markdown).toContain("Valve 7");
    },
    scrapeTimeout * 2,
  );

  it.concurrent(
    "keeps direct extraction for fast mode",
    async () => {
      const result = await parse(
        {
          options: {
            formats: ["markdown"],
            parsers: [{ type: "pdf", mode: "fast" }],
          },
          file: fixture("parse-text.pdf"),
        },
        identity,
      );

      expect(result.markdown).toContain("Quarterly Field Notes");
    },
    scrapeTimeout,
  );

  it.concurrent(
    "fails cleanly for a corrupt PDF",
    async () => {
      const response = await parseWithFailure(
        {
          options: { formats: ["markdown"] },
          file: {
            content: Buffer.from("%PDF-1.7\n%not a real document body\n"),
            filename: "corrupt.pdf",
            contentType: "application/pdf",
          },
        },
        identity,
      );

      expect(response.success).toBe(false);
      expect(response.code).toBeDefined();
    },
    scrapeTimeout,
  );
});

describeIf(FIRE_PDF_ON && !!config.PDF_RUST_EXTRACT_ENABLE)(
  "/v2/parse fast mode on scanned PDFs",
  () => {
    it.concurrent(
      "still refuses OCR in fast mode",
      async () => {
        const response = await parseWithFailure(
          {
            options: {
              formats: ["markdown"],
              parsers: [{ type: "pdf", mode: "fast" }],
            },
            file: fixture("parse-scanned.pdf"),
          },
          identity,
        );

        expect(response.success).toBe(false);
        expect(response.code).toBe("SCRAPE_PDF_OCR_REQUIRED");
      },
      scrapeTimeout,
    );
  },
);

describeIf(FIRE_PDF_ON && config.PARSE_FIRE_PDF_TABLE_FORMAT === "dynamic")(
  "/v2/parse dynamic table format",
  () => {
    it.concurrent(
      "returns merged-cell tables as HTML and simple tables as pipe tables",
      async () => {
        const result = await parse(
          {
            options: { formats: ["markdown"] },
            file: fixture("parse-tables.pdf"),
          },
          identity,
        );
        const markdown = result.markdown ?? "";
        const tables = markdown.match(/<table[\s\S]*?<\/table>/gi) ?? [];

        expect(tables).toHaveLength(1);
        expect(tables[0]).toMatch(/colspan=["']?2/i);
        expect(tables[0]).toContain("Region");
        expect(tables[0]).toContain("2025");
        expect(tables[0]).not.toContain("Apples");
        expect(markdown).toMatch(/\|\s*Fruit\s*\|\s*Quantity\s*\|/);
        expect(markdown).toMatch(/\|\s*Apples\s*\|\s*42\s*\|/);
      },
      scrapeTimeout * 2,
    );
  },
);
