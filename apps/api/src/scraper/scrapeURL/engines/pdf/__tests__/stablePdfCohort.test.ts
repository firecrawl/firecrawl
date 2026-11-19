import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectPdf, processPdf } from "@mendable/firecrawl-rs";
import { config } from "../../../../../config";
import { scrapePDFWithFirePDF } from "../firePDF";
import { scrapePDFWithParsePDF } from "../pdfParse";
import { deterministicPercentage, pdfCohortKey } from "../fire-pdf/routing";
import { scrapePDF } from "../index";

vi.mock("@mendable/firecrawl-rs", () => ({
  processPdf: vi.fn(),
  detectPdf: vi.fn(),
}));

vi.mock("../firePDF", async importOriginal => ({
  ...(await importOriginal<typeof import("../firePDF")>()),
  scrapePDFWithFirePDF: vi.fn(),
}));

vi.mock("../pdfParse", () => ({
  scrapePDFWithParsePDF: vi.fn(),
}));

vi.mock("../markdownToHtml", () => ({
  safeMarkdownToHtml: vi.fn(async (markdown: string) => `<p>${markdown}</p>`),
}));

const mockedProcessPdf = vi.mocked(processPdf);
const mockedDetectPdf = vi.mocked(detectPdf);
const mockedFirePdf = vi.mocked(scrapePDFWithFirePDF);
const mockedPdfParse = vi.mocked(scrapePDFWithParsePDF);

const configKeys = [
  "PDF_RUST_EXTRACT_ENABLE",
  "FIRE_PDF_ENABLE",
  "FIRE_PDF_BASE_URL",
  "FIRE_PDF_PERCENT",
  "FIRE_PDF_ASYNC_PERCENT",
  "MINERU_PERCENT",
  "RUNPOD_MU_API_KEY",
  "RUNPOD_MU_POD_ID",
  "PARSE_PDF_ALWAYS_FIRE_PDF",
] as const;
const originalConfig = Object.fromEntries(
  configKeys.map(key => [key, config[key]]),
);

function setConfig(
  overrides: Partial<Record<(typeof configKeys)[number], unknown>>,
) {
  Object.assign(config as any, overrides);
}

const tempDirs: string[] = [];

async function makeMeta(
  id: string,
  url: string,
  internalOptions: Record<string, unknown> = {},
) {
  const dir = await mkdtemp(path.join(tmpdir(), "stable-pdf-cohort-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, "doc.pdf");
  await writeFile(filePath, "%PDF-1.7\n%test\n");
  const logger: any = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  logger.child = vi.fn(() => logger);
  return {
    id,
    url,
    rewrittenUrl: url,
    options: { parsers: ["pdf"] },
    logger,
    featureFlags: new Set(["pdf"]),
    pdfPrefetch: {
      filePath,
      url,
      status: 200,
      proxyUsed: "basic",
    },
    abort: {
      throwIfAborted: vi.fn(),
      asSignal: vi.fn(() => new AbortController().signal),
      scrapeTimeout: vi.fn(() => 60_000),
    },
    internalOptions: { teamId: "team-test", ...internalOptions },
  } as any;
}

const ineligibleTextPdf = {
  pdfType: "TextBased",
  confidence: 0.99,
  isComplex: true,
  pageCount: 4,
  markdown: "rust markdown",
  title: null,
  pagesNeedingOcr: [],
  logs: [],
};

const eligibleTextPdf = {
  ...ineligibleTextPdf,
  isComplex: false,
  markdown: "direct extraction",
};

function splitUrls(prefix: string, percent: number) {
  let inside = "";
  let outside = "";
  for (let i = 0; i < 500 && (!inside || !outside); i++) {
    const url = `https://example.com/${prefix}-${i}.pdf`;
    if (deterministicPercentage(`${prefix}:${url}`) < percent) {
      inside ||= url;
    } else {
      outside ||= url;
    }
  }
  if (!inside || !outside) {
    throw new Error(`could not split ${prefix} cohort`);
  }
  return { inside, outside };
}

function splitIds(prefix: string, percent: number) {
  let inside = "";
  let outside = "";
  for (let i = 0; i < 500 && (!inside || !outside); i++) {
    const id = `${prefix}-${i}`;
    if (deterministicPercentage(`${prefix}:${id}`) < percent) {
      inside ||= id;
    } else {
      outside ||= id;
    }
  }
  if (!inside || !outside) {
    throw new Error(`could not split ${prefix} ids`);
  }
  return { inside, outside };
}

const sameFilenameUpload =
  "https://parse.firecrawl.dev/uploads/quarterly-report.pdf";

describe("stable PDF engine cohort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setConfig({
      PDF_RUST_EXTRACT_ENABLE: true,
      FIRE_PDF_ENABLE: true,
      FIRE_PDF_BASE_URL: "http://fire-pdf.test",
      FIRE_PDF_PERCENT: 50,
      FIRE_PDF_ASYNC_PERCENT: 0,
      MINERU_PERCENT: 0,
      RUNPOD_MU_API_KEY: undefined,
      RUNPOD_MU_POD_ID: undefined,
      PARSE_PDF_ALWAYS_FIRE_PDF: false,
    });
    mockedProcessPdf.mockResolvedValue(ineligibleTextPdf as any);
    mockedDetectPdf.mockResolvedValue({
      pdfType: "TextBased",
      pageCount: 4,
      title: null,
      logs: [],
    } as any);
    mockedFirePdf.mockResolvedValue({
      markdown: "fire-pdf",
      html: "<p>fire-pdf</p>",
      pagesProcessed: 4,
    });
    mockedPdfParse.mockResolvedValue({
      markdown: "pdf-parse",
      html: "<p>pdf-parse</p>",
    });
  });

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })),
    );
  });

  afterAll(() => {
    Object.assign(config as any, originalConfig);
  });

  it("keeps one URL on one engine across scrapes", async () => {
    const url =
      "https://www.cms.gov/cciio/resources/forms-reports-and-other-resources/downloads/english-sample-completed-sbc-accessible-format-012825.pdf";
    const markdowns: string[] = [];
    for (let i = 0; i < 12; i++) {
      markdowns.push(
        (await scrapePDF(await makeMeta(`scrape-${i}`, url))).markdown ?? "",
      );
    }

    expect(new Set(markdowns).size).toBe(1);
    const expectFirePdf = deterministicPercentage(`fire-pdf:${url}`) < 50;
    expect(markdowns[0]).toBe(expectFirePdf ? "fire-pdf" : "pdf-parse");
  });

  it("can place two URLs on different engines at the same percentage", async () => {
    const { inside, outside } = splitUrls("fire-pdf", 50);

    expect((await scrapePDF(await makeMeta("in", inside))).markdown).toBe(
      "fire-pdf",
    );
    expect((await scrapePDF(await makeMeta("out", outside))).markdown).toBe(
      "pdf-parse",
    );
  });

  it("falls back to pdf-parse when the stable FirePDF cohort fails", async () => {
    const { inside } = splitUrls("fire-pdf", 50);
    mockedFirePdf.mockRejectedValue(new Error("fire-pdf 503"));

    const first = await scrapePDF(await makeMeta("fail-a", inside));
    const second = await scrapePDF(await makeMeta("fail-b", inside));

    expect(first.markdown).toBe("pdf-parse");
    expect(second.markdown).toBe("pdf-parse");
    expect(mockedFirePdf).toHaveBeenCalledTimes(2);
  });

  it("keeps the MinerU diversion stable for one URL across scrapes", async () => {
    setConfig({
      FIRE_PDF_ENABLE: false,
      FIRE_PDF_BASE_URL: undefined,
      FIRE_PDF_PERCENT: 0,
      MINERU_PERCENT: 50,
    });
    mockedProcessPdf.mockResolvedValue(eligibleTextPdf as any);
    const url = "https://example.com/same-bytes.pdf";
    const markdowns: string[] = [];
    for (let i = 0; i < 12; i++) {
      markdowns.push(
        (await scrapePDF(await makeMeta(`mineru-${i}`, url))).markdown ?? "",
      );
    }

    expect(new Set(markdowns).size).toBe(1);
    const diverted = deterministicPercentage(`mineru:${url}`) < 50;
    expect(markdowns[0]).toBe(diverted ? "pdf-parse" : "direct extraction");
  });

  it("cohorts same-filename uploads by scrape id and keeps one URL stable", () => {
    const upload = {
      url: sameFilenameUpload,
      rewrittenUrl: sameFilenameUpload,
      internalOptions: { isParse: true },
    };
    expect(pdfCohortKey({ id: "upload-a", ...upload })).toBe("upload-a");
    expect(pdfCohortKey({ id: "upload-b", ...upload })).toBe("upload-b");
    expect(
      pdfCohortKey({
        id: "upload-c",
        url: sameFilenameUpload,
        rewrittenUrl: sameFilenameUpload,
        internalOptions: {
          uploadedFile: {
            buffer: Buffer.from("%PDF"),
            filename: "quarterly-report.pdf",
          },
        },
      }),
    ).toBe("upload-c");

    const url = "https://example.com/same.pdf";
    const zdrScrape = {
      id: "scrape-b",
      url,
      rewrittenUrl: url,
      internalOptions: { zeroDataRetention: true },
    };
    expect(pdfCohortKey({ id: "scrape-a", url, rewrittenUrl: url })).toBe(url);
    expect(pdfCohortKey(zdrScrape)).toBe(url);
  });

  it("sends two same-filename parse uploads to different FirePDF cohorts", async () => {
    const { inside, outside } = splitIds("fire-pdf", 50);
    const upload = { isParse: true };

    expect(
      (await scrapePDF(await makeMeta(inside, sameFilenameUpload, upload)))
        .markdown,
    ).toBe("fire-pdf");
    expect(
      (await scrapePDF(await makeMeta(outside, sameFilenameUpload, upload)))
        .markdown,
    ).toBe("pdf-parse");
  });

  it("sends two same-filename parse uploads to different MinerU cohorts", async () => {
    setConfig({
      FIRE_PDF_ENABLE: false,
      FIRE_PDF_BASE_URL: undefined,
      FIRE_PDF_PERCENT: 0,
      MINERU_PERCENT: 50,
    });
    mockedProcessPdf.mockResolvedValue(eligibleTextPdf as any);
    const { inside, outside } = splitIds("mineru", 50);
    const upload = { isParse: true };

    expect(
      (await scrapePDF(await makeMeta(inside, sameFilenameUpload, upload)))
        .markdown,
    ).toBe("pdf-parse");
    expect(
      (await scrapePDF(await makeMeta(outside, sameFilenameUpload, upload)))
        .markdown,
    ).toBe("direct extraction");
  });
});
