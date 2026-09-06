import { embeddedPdfPostprocessor, extractEmbeddedPdfUrl } from "../embeddedPdf";
import { isPdfUrl } from "../../../../lib/document-formats";

describe("isPdfUrl", () => {
  it("returns true for direct PDF URLs", () => {
    expect(isPdfUrl("https://example.com/document.pdf")).toBe(true);
    expect(isPdfUrl("https://example.com/path/to/document.pdf")).toBe(true);
  });

  it("returns true for PDF URLs with query parameters", () => {
    expect(isPdfUrl("https://example.com/document.pdf?download=1")).toBe(true);
    expect(isPdfUrl("https://example.com/document.pdf?token=abc")).toBe(true);
  });

  it("returns true for PDF URLs with fragments", () => {
    expect(isPdfUrl("https://example.com/document.pdf#page=1")).toBe(true);
    expect(isPdfUrl("https://example.com/document.pdf#page=5")).toBe(true);
  });

  it("returns false for non-PDF URLs", () => {
    expect(isPdfUrl("https://example.com/document.html")).toBe(false);
    expect(isPdfUrl("https://example.com/document.docx")).toBe(false);
    expect(isPdfUrl("https://example.com/document")).toBe(false);
    expect(isPdfUrl("https://example.com/")).toBe(false);
  });

  it("returns false for invalid URLs", () => {
    expect(isPdfUrl("not-a-url")).toBe(false);
    expect(isPdfUrl("")).toBe(false);
  });
});

describe("extractEmbeddedPdfUrl", () => {
  const baseUrl = "https://example.com/page";

  it("extracts PDF from iframe src", () => {
    const html = '<iframe src="document.pdf"></iframe>';
    const result = extractEmbeddedPdfUrl(html, baseUrl);
    expect(result).toBe("https://example.com/document.pdf");
  });

  it("extracts PDF from object data", () => {
    const html = '<object data="document.pdf"></object>';
    const result = extractEmbeddedPdfUrl(html, baseUrl);
    expect(result).toBe("https://example.com/document.pdf");
  });

  it("extracts PDF from embed src", () => {
    const html = '<embed src="document.pdf"></embed>';
    const result = extractEmbeddedPdfUrl(html, baseUrl);
    expect(result).toBe("https://example.com/document.pdf");
  });

  it("extracts PDF from iframe with full URL", () => {
    const html = '<iframe src="https://other.com/doc.pdf"></iframe>';
    const result = extractEmbeddedPdfUrl(html, baseUrl);
    expect(result).toBe("https://other.com/doc.pdf");
  });

  it("extracts PDF from object with relative path", () => {
    const html = '<object data="/docs/report.pdf"></object>';
    const result = extractEmbeddedPdfUrl(html, baseUrl);
    expect(result).toBe("https://example.com/docs/report.pdf");
  });

  it("returns null for HTML without embedded PDFs", () => {
    const html = '<div>No PDF here</div>';
    const result = extractEmbeddedPdfUrl(html, baseUrl);
    expect(result).toBeNull();
  });

  it("returns null for iframe with non-PDF src", () => {
    const html = '<iframe src="page.html"></iframe>';
    const result = extractEmbeddedPdfUrl(html, baseUrl);
    expect(result).toBeNull();
  });

  it("handles malformed HTML gracefully", () => {
    const html = '<iframe src="doc.pdf">unclosed';
    const result = extractEmbeddedPdfUrl(html, baseUrl);
    expect(result).toBe("https://example.com/doc.pdf");
  });

  it("prefers first embedded PDF found", () => {
    const html = '<iframe src="first.pdf"></iframe><object data="second.pdf"></object>';
    const result = extractEmbeddedPdfUrl(html, baseUrl);
    expect(result).toBe("https://example.com/first.pdf");
  });
});

describe("embeddedPdfPostprocessor.shouldRun", () => {
  const baseMeta = {
    options: { lockdown: false },
    featureFlags: new Set(),
  } as any;

  it("returns false when already processed", () => {
    expect(
      embeddedPdfPostprocessor.shouldRun(
        baseMeta,
        new URL("https://example.com"),
        ["embedded-pdf"],
      ),
    ).toBe(false);
  });

  it("returns false for lockdown", () => {
    expect(
      embeddedPdfPostprocessor.shouldRun(
        { ...baseMeta, options: { lockdown: true } },
        new URL("https://example.com"),
      ),
    ).toBe(false);
  });

  it("returns false for PDF feature flag", () => {
    expect(
      embeddedPdfPostprocessor.shouldRun(
        { ...baseMeta, featureFlags: new Set(["pdf"]) },
        new URL("https://example.com"),
      ),
    ).toBe(false);
  });

  it("returns true for normal HTML pages", () => {
    expect(
      embeddedPdfPostprocessor.shouldRun(
        baseMeta,
        new URL("https://example.com/page"),
      ),
    ).toBe(true);
  });
});

describe("embeddedPdfPostprocessor.run", () => {
  const baseMeta = {
    options: { lockdown: false },
    featureFlags: new Set(),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      child: () => ({ info: vi.fn(), warn: vi.fn() }),
    },
    url: "https://example.com/page",
  } as any;

  const baseEngineResult = {
    url: "https://example.com/page",
    html: '<iframe src="document.pdf"></iframe>',
    markdown: "original page",
  } as any;

  it("returns original result when no embedded PDF found", async () => {
    const meta = { ...baseMeta, logger: { info: vi.fn(), warn: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn() }) } };
    const engineResult = { ...baseEngineResult, html: "<div>No PDF</div>" };

    const result = await embeddedPdfPostprocessor.run(meta, engineResult);
    expect(result).toBe(engineResult);
  });

  it("returns original result when no HTML", async () => {
    const meta = { ...baseMeta, logger: { info: vi.fn(), warn: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn() }) } };
    const engineResult = { ...baseEngineResult, html: null };

    const result = await embeddedPdfPostprocessor.run(meta, engineResult);
    expect(result).toBe(engineResult);
  });

  it("returns original result for lockdown", async () => {
    const meta = { ...baseMeta, options: { lockdown: true }, logger: { info: vi.fn(), warn: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn() }) } };

    const result = await embeddedPdfPostprocessor.run(meta, baseEngineResult);
    expect(result).toBe(baseEngineResult);
  });

  it("attempts to scrape embedded PDF when found", async () => {
    // This test verifies the postprocessor correctly identifies embedded PDFs
    // and attempts to scrape them. The actual PDF engine call is tested separately.
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      child: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        child: () => ({ info: vi.fn(), warn: vi.fn() }),
      }),
    };
    const meta = {
      ...baseMeta,
      logger,
      url: "https://example.com/page",
      options: { lockdown: false },
      featureFlags: new Set(),
    };

    const engineResult = { ...baseEngineResult };

    // The postprocessor will try to call the PDF engine, which will fail
    // in this test environment. We just verify it doesn't crash and logs appropriately.
    const result = await embeddedPdfPostprocessor.run({ ...meta, logger }, engineResult);

    // Should return original result when PDF engine fails
    expect(result).toEqual(engineResult);
    expect(logger.warn).toHaveBeenCalled();
  });
});