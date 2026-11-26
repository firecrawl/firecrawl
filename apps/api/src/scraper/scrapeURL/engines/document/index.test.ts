import { afterEach, describe, expect, it, vi } from "vitest";
import { UnsupportedFileError } from "../../error";

const mocks = vi.hoisted(() => ({
  fetchFileToBuffer: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn(),
  unlink: vi.fn(async () => undefined),
  convertDocumentToMarkdown: vi.fn(async () => "# Converted"),
}));

vi.mock("../utils/downloadFile", async importOriginal => {
  const actual = await importOriginal<typeof import("../utils/downloadFile")>();
  return {
    ...actual,
    fetchFileToBuffer: mocks.fetchFileToBuffer,
  };
});

vi.mock("node:fs/promises", () => ({
  stat: mocks.stat,
  readFile: mocks.readFile,
  unlink: mocks.unlink,
}));

vi.mock("@mendable/firecrawl-rs", () => ({
  convertDocumentToMarkdown: mocks.convertDocumentToMarkdown,
}));

vi.mock("../pdf/markdownToHtml", () => ({
  safeMarkdownToHtml: vi.fn(async (md: string) => `<p>${md}</p>`),
}));

import { DOCUMENT_MAX_FILE_BYTES, scrapeDocument } from "./index";

function makeMeta(url: string, documentPrefetch?: any): any {
  const abortController = new AbortController();
  return {
    id: "doc-test-1",
    url,
    rewrittenUrl: undefined,
    internalOptions: { forceEngine: "document" },
    featureFlags: new Set(["document"]),
    options: {
      headers: undefined,
      skipTlsVerification: false,
    },
    abort: {
      asSignal: () => abortController.signal,
    },
    documentPrefetch,
    pdfPrefetch: undefined,
    imagePrefetch: undefined,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
}

describe("scrapeDocument size caps", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("passes DOCUMENT_MAX_FILE_BYTES to direct fetchFileToBuffer downloads", async () => {
    mocks.fetchFileToBuffer.mockRejectedValueOnce(
      new UnsupportedFileError("File exceeds size limit"),
    );

    await expect(
      scrapeDocument(makeMeta("https://example.com/download?id=99")),
    ).rejects.toThrow("File exceeds size limit");

    expect(mocks.fetchFileToBuffer).toHaveBeenCalledWith(
      "https://example.com/download?id=99",
      false,
      expect.any(Object),
      DOCUMENT_MAX_FILE_BYTES,
    );
  });

  it("rejects oversized prefetched files before reading them into memory and unlinks the temp file", async () => {
    mocks.stat.mockResolvedValueOnce({ size: DOCUMENT_MAX_FILE_BYTES + 1 });

    await expect(
      scrapeDocument(
        makeMeta("https://example.com/large.doc", {
          filePath: "/tmp/tempFile-oversized.doc",
          status: 200,
          proxyUsed: "basic",
          contentType: "application/msword",
        }),
      ),
    ).rejects.toThrow("File exceeds size limit");

    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.unlink).toHaveBeenCalledWith("/tmp/tempFile-oversized.doc");
  });
});
