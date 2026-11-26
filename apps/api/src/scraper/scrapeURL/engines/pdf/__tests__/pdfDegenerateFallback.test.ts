import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { processPdf } from "@mendable/firecrawl-rs";
import { getIneligibleReason, scrapePDF } from "../index";
import { isExtractionQualityRejection } from "../pdfQuality";
import { config } from "../../../../../config";
import type { Meta } from "../../..";

// The download is the only boundary mocked here: the native Rust extraction
// and the pdf-parse fallback both run for real. Temp files are written to
// the OS tmpdir exactly as the real downloader would, so the temp-file
// cleanup assertion observes the real finally block.
const mockState = vi.hoisted(() => ({
  pdfBytes: Buffer.alloc(0) as Buffer,
  tempPaths: [] as string[],
}));

vi.mock("../../utils/downloadFile", () => ({
  downloadFile: vi.fn(async (..._args: any[]): Promise<any> => {
    const tempFilePath = path.join(
      tmpdir(),
      `fc-degenerate-test-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`,
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

function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

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
  "Students organized a science fair with robotics and astronomy exhibits.",
  "The transport office published new bus timetables for rural routes.",
  "Health workers began the vaccination drive in remote villages today.",
  "The archives digitized newspapers dating back to nineteen forty two.",
  "Gardeners restored the botanical park paths and rose garden beds.",
  "The fire brigade held drills for high rise evacuation procedures.",
  "Auditors reviewed municipal accounts and reported full compliance.",
  "The choir prepared seasonal concerts in the town hall auditorium.",
  "Planners mapped flood zones and proposed new drainage channels.",
  "The museum opened an exhibition on maritime trade and shipbuilding.",
  "Volunteers cleaned the beach and catalogued collected plastic waste.",
  "The court scheduled hearings for land registry disputes next month.",
];

const SLIDE_TITLES = [
  "Q3 Growth Strategy Review Regional Performance and Outlook",
  "Supply Chain Resilience Lessons From the Port Disruption",
  "Customer Retention Playbook Onboarding and Success Metrics",
  "Product Roadmap Deep Dive Mobile First Design Principles",
  "Hiring Plan Engineering Capacity for the Next Two Quarters",
  "Security Posture Audit Findings and Remediation Timeline",
  "Brand Refresh Launch Campaign Channels and Measurement",
  "Pricing Experiments Results From the Latest Cohort Analysis",
  "Partnership Ecosystem Co Selling Motion With Cloud Vendors",
  "Annual Planning Cycle Goals Budgets and Accountability",
];

interface PageSpec {
  /** Direct-stream text lines (black). */
  direct: string[];
  /** Form-body lines + fill (the #5759 shape). Absent = no form. */
  formBody?: { lines: string[]; fill: "white" | "black" };
  /** Paint a full-page raster image inside the form (after the text). */
  formImage?: boolean;
}

/**
 * Deterministic PDF-1.4 builder, zero new deps. The degenerate shape is a
 * nested Form XObject whose body text is white-filled, with an opaque
 * raster painted over it — the structure that suppresses body text in the
 * Rust detector while headers survive. An Image XObject is declared in a
 * page's Resources only when the page actually paints it: declaring an
 * unused image poisons the detector's page classification.
 */
function buildPdf(pages: PageSpec[]): Buffer {
  const objects = new Map<number, Buffer>();
  const chunks: Buffer[] = [];
  const offsets = new Map<number, number>();
  let pos = 0;
  const imgBytes = Buffer.from([0, 0, 0]);

  let nextId = 5;
  const kids: string[] = [];
  for (const page of pages) {
    const pageId = nextId++;
    const contentId = nextId++;
    const innerId = page.formBody ? nextId++ : 0;
    const outerId = page.formBody ? nextId++ : 0;
    kids.push(`${pageId} 0 R`);

    const directOps = page.direct
      .map((line, j) => `${j === 0 ? "" : "0 -14 Td "}(${esc(line)}) Tj`)
      .join(" ");
    let content = `0 0 0 rg BT /F1 12 Tf 72 740 Td ${directOps} ET`;
    if (page.formBody) {
      content += ` q 1 0 0 1 0 0 cm /FmOuter Do Q`;
      const fill = page.formBody.fill === "white" ? "1 1 1 rg" : "0 0 0 rg";
      const bodyOps = page.formBody.lines
        .map((line, j) => `${j === 0 ? "" : "0 -14 Td "}(${esc(line)}) Tj`)
        .join(" ");
      let inner = `${fill} BT /F1 12 Tf 72 700 Td ${bodyOps} ET`;
      if (page.formImage) inner += ` q 612 0 0 650 0 60 cm /Im1 Do Q`;
      objects.set(
        innerId,
        Buffer.from(
          `<< /Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >>${page.formImage ? " /XObject << /Im1 4 0 R >>" : ""} >> /Length ${inner.length} >>\nstream\n${inner}\nendstream`,
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
    }
    const usesImage = page.formImage === true;
    const xobj = page.formBody
      ? `/XObject << /FmInner ${innerId} 0 R /FmOuter ${outerId} 0 R${usesImage ? " /Im1 4 0 R" : ""} >>`
      : "";
    objects.set(
      pageId,
      Buffer.from(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> ${xobj} >> /Contents ${contentId} 0 R >>`,
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
      `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`,
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
  chunks.push(imgBytes);
  pos += imgBytes.length;
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

const SHORT_HEADER = (n: number) => [
  "Municipal Gazette of Estancia",
  "Prefeitura Municipal de Estancia",
  `Year VIII Number ${5300 + n}`,
  "Official Bulletin Header Line",
  "Gazette Edition Header",
];

const VERBOSE_HEADER = (n: number, m: number) => [
  `Confidential Acme Corporation Quarterly Gazette Municipal Bulletin Page ${n} of ${m} All rights reserved internal distribution only`,
  `Legal notice and publication details for edition ${5300 + n} of the municipal gazette archive volume twelve section four`,
  "Prefeitura Municipal de Estancia Secretaria de Administracao e Financas Departamento de Publicacoes Oficiais",
];

function bodyForPage(p: number, count: number): string[] {
  const out: string[] = [];
  for (let k = 0; k < count; k++) {
    out.push(SENTENCES[(p * 3 + k) % SENTENCES.length]);
  }
  return out;
}

function degeneratePdf(
  pages: number,
  header: (n: number, m: number) => string[],
  fill: "white" | "black" = "white",
): Buffer {
  return buildPdf(
    Array.from({ length: pages }, (_, i) => ({
      direct: header(i + 1, pages),
      formBody: { lines: bodyForPage(i, 8), fill },
      formImage: true,
    })),
  );
}

function healthyPdf(pages: number): Buffer {
  return buildPdf(
    Array.from({ length: pages }, (_, i) => ({
      direct: [
        "Municipal Gazette of Estancia",
        ...bodyForPage(i, 8),
        "End of page footer notes and references",
      ],
    })),
  );
}

function slidesPdf(pages: number): Buffer {
  return buildPdf(
    Array.from({ length: pages }, (_, i) => ({
      direct: [SLIDE_TITLES[i % SLIDE_TITLES.length], "Acme Corp Confidential"],
    })),
  );
}

interface LoggedEvent {
  level: string;
  msg: string;
  fields: Record<string, unknown>;
}

function makeLogger() {
  const events: LoggedEvent[] = [];
  const logger: any = {
    events,
    debug: (msg: string, fields?: Record<string, unknown>) => {
      events.push({ level: "debug", msg, fields: fields ?? {} });
    },
    info: (msg: string, fields?: Record<string, unknown>) => {
      events.push({ level: "info", msg, fields: fields ?? {} });
    },
    warn: (msg: string, fields?: Record<string, unknown>) => {
      events.push({ level: "warn", msg, fields: fields ?? {} });
    },
    error: (msg: string, fields?: Record<string, unknown>) => {
      events.push({ level: "error", msg, fields: fields ?? {} });
    },
    child: () => logger,
  };
  return logger;
}

function makeMeta(
  parsers: unknown[],
  logger: ReturnType<typeof makeLogger>,
): Meta {
  return {
    id: "test-scrape-id",
    url: "http://example.com/doc.pdf",
    rewrittenUrl: "http://example.com/doc.pdf",
    options: {
      parsers,
      skipTlsVerification: false,
      headers: {},
    },
    abort: {
      asSignal: () => new AbortController().signal,
      scrapeTimeout: () => 600_000,
    },
    logger,
    featureFlags: new Set(["pdf"]),
    internalOptions: {},
    pdfPrefetch: undefined,
    documentPrefetch: undefined,
    imagePrefetch: undefined,
  } as unknown as Meta;
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("degenerate PDF fallback (issue #5759)", () => {
  let originalRustFlag: boolean | undefined;

  beforeAll(() => {
    originalRustFlag = config.PDF_RUST_EXTRACT_ENABLE;
    config.PDF_RUST_EXTRACT_ENABLE = true;
  });

  afterAll(() => {
    config.PDF_RUST_EXTRACT_ENABLE = originalRustFlag;
  });

  it("documents the detector behavior on a 1-page white-filled form: body suppressed, gate exempt", async () => {
    const pdf = degeneratePdf(1, SHORT_HEADER);
    const dir = await import("node:fs/promises").then(m =>
      m.mkdtemp(path.join(tmpdir(), "fc-detector-")),
    );
    const filePath = path.join(dir, "doc.pdf");
    await writeFile(filePath, pdf);
    try {
      const result = await processPdf(filePath);
      expect(result.pdfType).toBe("TextBased");
      expect(result.confidence).toBe(1);
      expect(result.isComplex).toBe(false);
      expect(result.pagesNeedingOcr).toEqual([]);
      expect(result.markdown).toContain("Municipal Gazette of Estancia");
      // The white-filled body text is suppressed by the detector.
      expect(result.markdown).not.toContain("The council approved");
      // ...but a 1-page document is exempt from the density gate.
      expect(getIneligibleReason(result, 1)).toBe(null);
      expect(getIneligibleReason(result)).toBe(null);
    } finally {
      await import("node:fs/promises").then(m =>
        m.rm(dir, { recursive: true }),
      );
    }
  });

  it("rejects a 5-page white-filled document and recovers the body via pdf-parse", async () => {
    mockState.pdfBytes = degeneratePdf(5, SHORT_HEADER);
    mockState.tempPaths = [];
    const logger = makeLogger();
    const result = await scrapePDF(makeMeta(["pdf"], logger));

    expect(result.markdown).toContain("The council approved the budget");
    expect((result.markdown ?? "").length).toBeGreaterThan(1000);

    const rejects = logger.events.filter(
      e => e.msg === "Rust PDF extraction rejected, falling back to PdfParse",
    );
    expect(rejects).toHaveLength(1);
    expect(
      isExtractionQualityRejection(rejects[0].fields.reason as string),
    ).toBe(true);
    expect(rejects[0].fields.effectivePages).toBe(5);
    expect(typeof rejects[0].fields.residualAlnum).toBe("number");
    // The rejection event carries counts only — never body text.
    expect(JSON.stringify(rejects[0].fields)).not.toContain(
      "The council approved",
    );

    // The downloaded temp file is cleaned up on the rejection path.
    expect(mockState.tempPaths).toHaveLength(1);
    expect(existsSync(mockState.tempPaths[0])).toBe(false);

    // The permit was released: a follow-up scrape completes.
    mockState.pdfBytes = healthyPdf(3);
    const followUp = await scrapePDF(makeMeta(["pdf"], makeLogger()));
    expect(followUp.markdown).toContain("The council approved the budget");
  });

  it("rejects a verbose-header degenerate via the density check specifically", async () => {
    mockState.pdfBytes = degeneratePdf(5, VERBOSE_HEADER);
    const logger = makeLogger();
    const result = await scrapePDF(makeMeta(["pdf"], logger));

    expect(result.markdown).toContain("The council approved the budget");
    const rejects = logger.events.filter(
      e => e.msg === "Rust PDF extraction rejected, falling back to PdfParse",
    );
    expect(rejects).toHaveLength(1);
    expect(rejects[0].fields.reason).toBe("sparse extraction");
    expect(rejects[0].fields.residualAlnum as number).toBeLessThan(400);
  });

  it("keeps the Rust extraction for a black-filled document and does not fall back", async () => {
    mockState.pdfBytes = degeneratePdf(5, SHORT_HEADER, "black");
    const logger = makeLogger();
    const result = await scrapePDF(makeMeta(["pdf"], logger));

    expect(result.markdown).toContain("The council approved the budget");
    // Rust's boilerplate filter keeps the repeated header once; pdf-parse
    // would repeat it on every page — so once means no fallback ran.
    expect(
      countOccurrences(result.markdown ?? "", "Municipal Gazette of Estancia"),
    ).toBe(1);
    expect(
      logger.events.filter(
        e => e.msg === "Rust PDF extraction rejected, falling back to PdfParse",
      ),
    ).toHaveLength(0);
  });

  it("accepts a legit-sparse slide deck", async () => {
    mockState.pdfBytes = slidesPdf(10);
    const logger = makeLogger();
    const result = await scrapePDF(makeMeta(["pdf"], logger));

    for (const title of SLIDE_TITLES) {
      expect(result.markdown).toContain(title);
    }
    expect(
      logger.events.filter(
        e => e.msg === "Rust PDF extraction rejected, falling back to PdfParse",
      ),
    ).toHaveLength(0);
  });

  it("accepts a 1-page sparse flyer", async () => {
    mockState.pdfBytes = buildPdf([
      { direct: ["Grand Opening Sale This Weekend Only", "Visit our store"] },
    ]);
    const logger = makeLogger();
    const result = await scrapePDF(makeMeta(["pdf"], logger));

    expect(result.markdown).toContain("Grand Opening Sale");
    expect(
      logger.events.filter(
        e => e.msg === "Rust PDF extraction rejected, falling back to PdfParse",
      ),
    ).toHaveLength(0);
  });

  it("recovers a degenerate document in fast mode without the OCR error", async () => {
    mockState.pdfBytes = degeneratePdf(5, SHORT_HEADER);
    const logger = makeLogger();
    const result = await scrapePDF(
      makeMeta([{ type: "pdf", mode: "fast" }], logger),
    );

    expect(result.markdown).toContain("The council approved the budget");
    const rejects = logger.events.filter(
      e => e.msg === "Rust PDF extraction rejected, falling back to PdfParse",
    );
    expect(rejects).toHaveLength(1);
    expect(rejects[0].fields.mode).toBe("fast");
  });

  it("honors maxPages: a 20-page document capped at 2 pages is exempt", async () => {
    mockState.pdfBytes = healthyPdf(20);
    const logger = makeLogger();
    const result = await scrapePDF(
      makeMeta([{ type: "pdf", maxPages: 2 }], logger),
    );

    expect(
      logger.events.filter(
        e => e.msg === "Rust PDF extraction rejected, falling back to PdfParse",
      ),
    ).toHaveLength(0);
    expect(result.markdown).toContain("The council approved the budget");
    // Sentences first appearing on page 3+ are not extracted (sentence 14
    // first appears on page 3 under the rotation used by the fixture).
    expect(result.markdown).not.toContain(
      "Health workers began the vaccination drive",
    );
    expect(result.pdfMetadata?.numPages).toBe(2);
    expect(result.pdfMetadata?.totalPages).toBe(20);
  });
});
