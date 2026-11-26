import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { scrapePDF } from "../index";
import { config } from "../../../../../config";
import type { Meta } from "../../..";

// Same mocked-download harness as pdfDegenerateFallback.test.ts: the only
// boundary mocked is the download. The pdf-parse fallback itself is
// replaced with a throwing double here, to prove a rejected Rust result is
// never silently returned when the fallback fails.
const mockState = vi.hoisted(() => ({
  pdfBytes: Buffer.alloc(0) as Buffer,
  tempPaths: [] as string[],
}));

vi.mock("../../utils/downloadFile", () => ({
  downloadFile: vi.fn(async (..._args: any[]): Promise<any> => {
    const tempFilePath = path.join(
      tmpdir(),
      `fc-degenerate-failure-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`,
    );
    const { writeFile: write } = await import("node:fs/promises");
    await write(tempFilePath, mockState.pdfBytes);
    mockState.tempPaths.push(tempFilePath);
    return {
      response: { url: "http://example.com/doc.pdf", status: 200 },
      tempFilePath,
    };
  }),
  fetchFileGuardingProxyFailure: vi.fn(
    async (_meta: any, fn: () => Promise<any>): Promise<any> => fn(),
  ),
  fetchFileToBuffer: vi.fn(),
}));

vi.mock("../pdfParse", () => ({
  PDF_PARSE_MAX_PAGES: 1000,
  scrapePDFWithParsePDF: vi.fn(async (): Promise<never> => {
    throw new Error("pdf-parse unavailable (test double)");
  }),
}));

function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

// Same TextBased degenerate shape as pdfDegenerateFallback.test.ts: five
// short-header lines in the page stream (black) + eight white-filled body
// sentences in a nested Form XObject under an opaque raster. The detector
// classifies this TextBased with high confidence and suppresses the body,
// so only the new extraction-quality gate rejects it — an ImageBased shape
// would be rejected by the pre-existing pdfType check instead and would
// not exercise the gate at all.
const SENTENCES = [
  "The council approved the budget for road repairs and public lighting.",
  "Quixotic delegates debated the new market square renovation project.",
  "Farmers requested support for irrigation systems and seed programs.",
  "The mayor signed the decree on waste collection and recycling routes.",
  "Teachers welcomed the school lunch and student transport funding.",
  "Local clinics received new equipment for maternal health services.",
  "Fishermen asked for harbor maintenance and seasonal fuel subsidies.",
  "The assembly ratified the cultural festival calendar for next year.",
  "Engineers presented the bridge inspection report and repair schedule.",
  "The library extended opening hours and added digital lending kiosks.",
  "Merchants proposed a night market along the renovated riverfront.",
  "The water board announced reservoir levels and conservation measures.",
];

function buildDegeneratePdf(pages: number): Buffer {
  const objects = new Map<number, Buffer>();
  const chunks: Buffer[] = [];
  const offsets = new Map<number, number>();
  let pos = 0;
  let nextId = 5;
  const kids: string[] = [];
  for (let p = 0; p < pages; p++) {
    const pageId = nextId++;
    const contentId = nextId++;
    const innerId = nextId++;
    const outerId = nextId++;
    kids.push(`${pageId} 0 R`);
    const header = [
      "Municipal Gazette of Estancia",
      "Prefeitura Municipal de Estancia",
      `Year VIII Number ${5300 + p + 1}`,
      "Official Bulletin Header Line",
      "Gazette Edition Header",
    ];
    const body = Array.from(
      { length: 8 },
      (_, k) => SENTENCES[(p * 3 + k) % SENTENCES.length],
    );
    const headerOps = header
      .map((line, j) => `${j === 0 ? "" : "0 -14 Td "}(${esc(line)}) Tj`)
      .join(" ");
    const bodyOps = body
      .map((line, j) => `${j === 0 ? "" : "0 -14 Td "}(${esc(line)}) Tj`)
      .join(" ");
    const inner =
      `1 1 1 rg BT /F1 12 Tf 72 700 Td ${bodyOps} ET` +
      ` q 612 0 0 650 0 60 cm /Im1 Do Q`;
    objects.set(
      innerId,
      Buffer.from(
        `<< /Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> /XObject << /Im1 4 0 R >> >> /Length ${inner.length} >>\nstream\n${inner}\nendstream`,
        "latin1",
      ),
    );
    const outerOps = `q 1 0 0 1 0 0 cm /FmInner Do Q`;
    objects.set(
      outerId,
      Buffer.from(
        `<< /Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << /XObject << /FmInner ${innerId} 0 R >> >> /Length ${outerOps.length} >>\nstream\n${outerOps}\nendstream`,
        "latin1",
      ),
    );
    const content =
      `0 0 0 rg BT /F1 12 Tf 72 740 Td ${headerOps} ET` +
      ` q 1 0 0 1 0 0 cm /FmOuter Do Q`;
    objects.set(
      pageId,
      Buffer.from(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> /XObject << /FmInner ${innerId} 0 R /FmOuter ${outerId} 0 R /Im1 4 0 R >> >> /Contents ${contentId} 0 R >>`,
        "latin1",
      ),
    );
    objects.set(
      contentId,
      Buffer.from(
        `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
        "latin1",
      ),
    );
  }
  const pushStr = (s: string) => {
    const b = Buffer.from(s, "latin1");
    chunks.push(b);
    pos += b.length;
  };
  const pushObj = (id: number, body: Buffer) => {
    offsets.set(id, pos);
    pushStr(`${id} 0 obj\n`);
    chunks.push(body);
    pos += body.length;
    pushStr("\nendobj\n");
  };
  pushStr("%PDF-1.4\n");
  pushObj(1, Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "latin1"));
  pushObj(
    2,
    Buffer.from(
      `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages} >>`,
      "latin1",
    ),
  );
  pushObj(
    3,
    Buffer.from(
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      "latin1",
    ),
  );
  offsets.set(4, pos);
  pushStr(
    `4 0 obj\n<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 3 >>\nstream\n`,
  );
  chunks.push(Buffer.from([0, 0, 0]));
  pos += 3;
  pushStr("\nendstream\nendobj\n");
  const maxId = Math.max(4, ...objects.keys());
  for (let id = 5; id <= maxId; id++) {
    const body = objects.get(id);
    if (body) pushObj(id, body);
  }
  const xrefPos = pos;
  let xref = `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maxId; id++) {
    xref += `${offsets.get(id) ?? 0}`.padStart(10, "0") + " 00000 n \n";
  }
  pushStr(
    `${xref}trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`,
  );
  return Buffer.concat(chunks);
}

function makeLogger() {
  const logger: any = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
  };
  return logger;
}

describe("degenerate PDF fallback failure path", () => {
  let originalRustFlag: boolean | undefined;

  beforeAll(() => {
    originalRustFlag = config.PDF_RUST_EXTRACT_ENABLE;
    config.PDF_RUST_EXTRACT_ENABLE = true;
  });

  afterAll(() => {
    config.PDF_RUST_EXTRACT_ENABLE = originalRustFlag;
  });

  it("propagates the fallback error instead of silently returning rejected markdown", async () => {
    mockState.pdfBytes = buildDegeneratePdf(5);
    mockState.tempPaths = [];
    const meta = {
      id: "test-scrape-id",
      url: "http://example.com/doc.pdf",
      rewrittenUrl: "http://example.com/doc.pdf",
      options: { parsers: ["pdf"], skipTlsVerification: false, headers: {} },
      abort: {
        asSignal: () => new AbortController().signal,
        scrapeTimeout: () => 600_000,
      },
      logger: makeLogger(),
      featureFlags: new Set(["pdf"]),
      internalOptions: {},
      pdfPrefetch: undefined,
      documentPrefetch: undefined,
      imagePrefetch: undefined,
    } as unknown as Meta;

    await expect(scrapePDF(meta)).rejects.toThrow(
      "pdf-parse unavailable (test double)",
    );
    // The temp file is still cleaned up when the fallback throws.
    expect(mockState.tempPaths).toHaveLength(1);
    expect(existsSync(mockState.tempPaths[0])).toBe(false);
  });
});
