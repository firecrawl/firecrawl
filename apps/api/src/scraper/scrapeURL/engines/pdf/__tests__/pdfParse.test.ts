const mocks = vi.hoisted(() => ({
  construct: vi.fn(),
  destroy: vi.fn(),
  getText: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile }));
vi.mock("pdf-parse", () => ({
  PDFParse: class {
    constructor(options: unknown) {
      mocks.construct(options);
    }

    getText = mocks.getText;
    destroy = mocks.destroy;
  },
}));

import { scrapePDFWithParsePDF } from "../pdfParse";

function makeMeta() {
  return {
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
  } as any;
}

describe("scrapePDFWithParsePDF", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the pdf-parse v2 API, escapes the result, and releases resources", async () => {
    const buffer = Buffer.from("pdf data");
    const meta = makeMeta();
    mocks.readFile.mockResolvedValue(buffer);
    mocks.getText.mockResolvedValue({ text: "<page> & text", total: 3 });
    mocks.destroy.mockResolvedValue(undefined);

    await expect(scrapePDFWithParsePDF(meta, "/tmp/file.pdf")).resolves.toEqual(
      {
        markdown: "&lt;page&gt; &amp; text",
        html: "&lt;page&gt; &amp; text",
      },
    );

    expect(mocks.readFile).toHaveBeenCalledWith("/tmp/file.pdf");
    expect(mocks.construct).toHaveBeenCalledWith({ data: buffer });
    expect(mocks.getText).toHaveBeenCalledWith({ pageJoiner: "" });
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(meta.logger.info).toHaveBeenCalledWith("pdfParse succeeded", {
      durationMs: expect.any(Number),
      markdownLength: 23,
      numPages: 3,
    });
  });

  it("releases resources and preserves the parse error when parsing fails", async () => {
    const parseError = new Error("invalid PDF");
    const meta = makeMeta();
    mocks.readFile.mockResolvedValue(Buffer.from("invalid pdf data"));
    mocks.getText.mockRejectedValue(parseError);
    mocks.destroy.mockResolvedValue(undefined);

    await expect(scrapePDFWithParsePDF(meta, "/tmp/invalid.pdf")).rejects.toBe(
      parseError,
    );

    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(meta.logger.error).toHaveBeenCalledWith("pdfParse failed", {
      error: parseError,
    });
  });

  it("preserves a successful result when cleanup fails", async () => {
    const destroyError = new Error("cleanup failed");
    const meta = makeMeta();
    mocks.readFile.mockResolvedValue(Buffer.from("pdf data"));
    mocks.getText.mockResolvedValue({ text: "parsed text", total: 1 });
    mocks.destroy.mockRejectedValue(destroyError);

    await expect(scrapePDFWithParsePDF(meta, "/tmp/file.pdf")).resolves.toEqual(
      {
        markdown: "parsed text",
        html: "parsed text",
      },
    );

    expect(meta.logger.warn).toHaveBeenCalledWith("pdfParse cleanup failed", {
      error: destroyError,
    });
    expect(meta.logger.error).not.toHaveBeenCalled();
  });

  it("does not mask a parse error when cleanup also fails", async () => {
    const parseError = new Error("invalid PDF");
    const destroyError = new Error("cleanup failed");
    const meta = makeMeta();
    mocks.readFile.mockResolvedValue(Buffer.from("invalid pdf data"));
    mocks.getText.mockRejectedValue(parseError);
    mocks.destroy.mockRejectedValue(destroyError);

    await expect(scrapePDFWithParsePDF(meta, "/tmp/invalid.pdf")).rejects.toBe(
      parseError,
    );

    expect(meta.logger.warn).toHaveBeenCalledWith("pdfParse cleanup failed", {
      error: destroyError,
    });
    expect(meta.logger.error).toHaveBeenCalledWith("pdfParse failed", {
      error: parseError,
    });
  });
});
