/**
 * Integration test for the embedded-PDF fix (issue #839).
 *
 * Strategy: mock the heavy I/O dependencies (downloadFile, fetchFileToBuffer,
 * native pdf bindings) so we can exercise the real detection + re-fetch logic
 * inside scrapePDF without needing a running server or ESM-incompatible deps.
 */

import { writeFile, unlink } from "node:fs/promises";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// Minimal valid 1-page PDF bytes
// ---------------------------------------------------------------------------
const MINIMAL_PDF = Buffer.from(
  "255044462d312e340a312030206f626a0a3c3c202f54797065202f436174616c6f670a202020202f50616765732032203020520a3e3e0a656e646f626a0a322030206f626a0a3c3c202f54797065202f50616765730a202020202f4b696473205b332030205d0a202020202f436f756e7420310a3e3e0a656e646f626a0a332030206f626a0a3c3c202f54797065202f506167650a202020202f506172656e742032203020520a202020202f4d65646961426f78205b302030203631322037393220200a202020205d0a3e3e0a656e646f626a0a787265660a302034200a303030303030303030302036353533352066200a303030303030303030392030303030302066200a303030303030303034332030303030302066200a303030303030303039382030303030302066200a747261696c65720a3c3c202f53697a6520340a202020202f526f6f742031203020520a3e3e0a7374617274787265660a3139380a2525454f46",
  "hex",
);

// ---------------------------------------------------------------------------
// Mocks — must be declared before any imports that pull the real modules
// ---------------------------------------------------------------------------
jest.mock("../../../engines/utils/downloadFile", () => ({
  downloadFile: jest.fn(),
  fetchFileToBuffer: jest.fn(),
}));

jest.mock("pdf-parse", () =>
  jest.fn().mockResolvedValue({ text: "Hello from PDF", numpages: 1 }),
);

jest.mock("@mendable/firecrawl-rs", () => ({
  processPdf: jest.fn(() => ({
    pdfType: "TextBased",
    pageCount: 1,
    confidence: 0.99,
    isComplex: false,
    markdown: "Hello from PDF",
    logs: [],
  })),
  detectPdf: jest.fn(() => ({ pdfType: "TextBased", pageCount: 1, logs: [] })),
}));

// ---------------------------------------------------------------------------
// Now import the module under test
// ---------------------------------------------------------------------------
import { scrapePDF } from "../index";
import {
  downloadFile,
  fetchFileToBuffer,
} from "../../../engines/utils/downloadFile";

const mockDownloadFile = downloadFile as jest.MockedFunction<
  typeof downloadFile
>;
const mockFetchFileToBuffer = fetchFileToBuffer as jest.MockedFunction<
  typeof fetchFileToBuffer
>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeMeta(url: string, htmlTempPath: string) {
  return {
    id: randomUUID(),
    url,
    rewrittenUrl: undefined,
    options: {
      formats: [{ type: "markdown" }],
      parsers: [],
      skipTlsVerification: false,
      onlyMainContent: true,
      waitFor: 0,
      mobile: false,
      fastMode: false,
      blockAds: true,
      proxy: "basic",
      __forceFirePDF: false,
    },
    internalOptions: { teamId: "test-team", zeroDataRetention: false },
    logger: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      child: () => ({
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        child: jest.fn(),
      }),
    },
    abort: {
      asSignal: () => undefined,
      throwIfAborted: () => {},
      scrapeTimeout: () => undefined,
      child: () => ({ dispose: jest.fn() }),
    },
    featureFlags: new Set(["pdf"]),
    mock: null,
    // pdfPrefetch points to the HTML file (simulates what downloadFile produced)
    pdfPrefetch: {
      filePath: htmlTempPath,
      url,
      status: 200,
      proxyUsed: "basic",
    },
    documentPrefetch: undefined,
    fetchPrefetch: undefined,
    costTracking: { add: jest.fn(), get: jest.fn(() => 0) },
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("scrapePDF — embedded PDF in HTML page (issue #839)", () => {
  let htmlTempPath: string;
  let pdfTempPath: string;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(async () => {
    if (htmlTempPath) await unlink(htmlTempPath).catch(() => {});
  });

  it("re-fetches and processes the real PDF found inside an HTML embed tag (shouldParse=true path)", async () => {
    const embeddedPdfUrl = "https://example.com/real.pdf";

    // Write HTML with embedded PDF to a temp file
    htmlTempPath = path.join(os.tmpdir(), `test-html-${randomUUID()}`);
    await writeFile(
      htmlTempPath,
      `<html><body><embed src="${embeddedPdfUrl}" type="application/pdf"></body></html>`,
    );

    // Write the real PDF to another temp file (returned by downloadFile re-fetch)
    const pdfTempPath = path.join(os.tmpdir(), `test-pdf-${randomUUID()}`);
    await writeFile(pdfTempPath, MINIMAL_PDF);

    mockDownloadFile.mockResolvedValue({
      response: { url: embeddedPdfUrl, status: 200 } as any,
      tempFilePath: pdfTempPath,
    });

    // Use parsers so shouldParse=true, triggering the isPdfBuffer check path
    const meta = {
      ...makeMeta("https://example.com/fake.pdf", htmlTempPath),
      options: {
        ...makeMeta("https://example.com/fake.pdf", htmlTempPath).options,
        parsers: [{ type: "pdf" }],
      },
    } as any;

    const result = await scrapePDF(meta);

    expect(result.contentType).toBe("application/pdf");
    expect(result.statusCode).toBe(200);
    // downloadFile must have been called with the embedded URL
    expect(mockDownloadFile).toHaveBeenCalledWith(
      expect.any(String),
      embeddedPdfUrl,
      expect.anything(),
      expect.anything(),
    );
  });

  it("returns HTML as base64 when no embedded PDF is found (no-parse path)", async () => {
    // When shouldParse=false and no embedded PDF is found, the code returns
    // the raw content as base64 — it does NOT throw. This is the existing
    // behaviour for non-PDF URLs that reach the pdf engine.
    htmlTempPath = path.join(os.tmpdir(), `test-html-${randomUUID()}`);
    const htmlContent = `<html><body><p>No PDF here</p></body></html>`;
    await writeFile(htmlTempPath, htmlContent);

    const meta = makeMeta("https://example.com/fake.pdf", htmlTempPath);
    const result = await scrapePDF(meta);

    // Content is returned as base64 of the HTML
    expect(result.contentType).toBe("application/pdf");
    expect(Buffer.from(result.markdown ?? "", "base64").toString()).toBe(
      htmlContent,
    );
    // fetchFileToBuffer should NOT have been called (no URL to re-fetch)
    expect(mockFetchFileToBuffer).not.toHaveBeenCalled();
  });
});
