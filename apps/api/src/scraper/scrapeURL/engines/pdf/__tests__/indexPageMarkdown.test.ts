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
            parsers: [{ type: "pdf", pageMarkdown: true }],
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
});
