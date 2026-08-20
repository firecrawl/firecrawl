vi.mock("../../../../../services", async importOriginal => ({
  ...(await importOriginal<typeof import("../../../../../services")>()),
  useIndex: true,
}));

import { config } from "../../../../../config";
import { shouldUseIndex } from "../../index";
import { sendDocumentToIndex } from "../../index/index";

describe("PDF page-markdown URL index policy", () => {
  it("bypasses URL-index reads for page-aware requests", () => {
    const originalWriteOnly = config.FIRECRAWL_INDEX_WRITE_ONLY;
    (
      config as { FIRECRAWL_INDEX_WRITE_ONLY?: boolean }
    ).FIRECRAWL_INDEX_WRITE_ONLY = false;
    const baseMeta = {
      internalOptions: { isParse: false },
      options: {
        formats: ["markdown"],
        parsers: [{ type: "pdf" }],
        maxAge: 60_000,
      },
    } as any;

    try {
      expect(shouldUseIndex(baseMeta)).toBe(true);
      expect(
        shouldUseIndex({
          ...baseMeta,
          options: {
            ...baseMeta.options,
            parsers: [{ type: "pdf", pages: true }],
          },
        }),
      ).toBe(false);
      // Deprecated pre-rename alias must keep working.
      expect(
        shouldUseIndex({
          ...baseMeta,
          options: {
            ...baseMeta.options,
            parsers: [{ type: "pdf", pageMarkdown: true }],
          },
        }),
      ).toBe(false);
      expect(
        shouldUseIndex({
          ...baseMeta,
          options: {
            ...baseMeta.options,
            parsers: [{ type: "pdf", blocks: true }],
          },
        }),
      ).toBe(false);
      expect(
        shouldUseIndex({
          ...baseMeta,
          options: {
            ...baseMeta.options,
            parsers: [{ type: "pdf", pageMarkers: true }],
          },
        }),
      ).toBe(false);
    } finally {
      (
        config as { FIRECRAWL_INDEX_WRITE_ONLY?: boolean }
      ).FIRECRAWL_INDEX_WRITE_ONLY = originalWriteOnly;
    }
  });

  it("does not write page-aware results to the document-only URL index", async () => {
    const document = {
      markdown: "whole document",
      pages: [{ pageNumber: 1, markdown: "page one" }],
      rawHtml: "<p>whole document</p>",
      metadata: {
        sourceURL: "https://example.com/file.pdf",
      },
    } as any;
    const meta = {
      url: "https://example.com/file.pdf",
      winnerEngine: "pdf",
      options: {
        storeInCache: true,
        parsers: [{ type: "pdf", pageMarkdown: true }],
      },
      internalOptions: {
        isParse: false,
        zeroDataRetention: false,
      },
    } as any;

    const result = await sendDocumentToIndex(meta, document);

    expect(result).toBe(document);
    expect(result.metadata.indexId).toBeUndefined();
  });

  it("does not write block-aware results to the document-only URL index", async () => {
    const document = {
      markdown: "whole document",
      blocks: [
        { pageNumber: 1, width: 800, height: 1100, status: "ok", items: [] },
      ],
      rawHtml: "<p>whole document</p>",
      metadata: {
        sourceURL: "https://example.com/file.pdf",
      },
    } as any;
    const meta = {
      url: "https://example.com/file.pdf",
      winnerEngine: "pdf",
      options: {
        storeInCache: true,
        parsers: [{ type: "pdf", blocks: true }],
      },
      internalOptions: {
        isParse: false,
        zeroDataRetention: false,
      },
    } as any;

    const result = await sendDocumentToIndex(meta, document);

    expect(result).toBe(document);
    expect(result.metadata.indexId).toBeUndefined();
  });

  it("does not write marker-bearing markdown to the URL index", async () => {
    const document = {
      markdown: "Page 1\n\n---\n\n<!-- page 2 -->\n\nPage 2",
      rawHtml: "<p>whole document</p>",
      metadata: {
        sourceURL: "https://example.com/file.pdf",
      },
    } as any;
    const meta = {
      url: "https://example.com/file.pdf",
      winnerEngine: "pdf",
      options: {
        storeInCache: true,
        parsers: [{ type: "pdf", pageMarkers: true }],
      },
      internalOptions: {
        isParse: false,
        zeroDataRetention: false,
      },
    } as any;

    const result = await sendDocumentToIndex(meta, document);

    expect(result).toBe(document);
    expect(result.metadata.indexId).toBeUndefined();
  });
});
