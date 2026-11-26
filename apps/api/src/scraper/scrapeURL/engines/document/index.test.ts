import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DocumentAntibotError,
  EngineUnsuccessfulError,
  UnsupportedFileError,
} from "../../error";

const mocks = vi.hoisted(() => ({
  fetchFileToBuffer: vi.fn(),
  undiciFetch: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn(),
  unlink: vi.fn(async () => undefined),
  convertDocumentToMarkdown: vi.fn(async () => "# Converted"),
}));

vi.mock("undici", async importOriginal => {
  const actual = await importOriginal<typeof import("undici")>();
  return {
    ...actual,
    fetch: mocks.undiciFetch,
  };
});

vi.mock("../utils/safeFetch", () => ({
  getSecureDispatcher: vi.fn(() => undefined),
  TLS_CERT_ERROR_CODES: new Set<string>(),
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
      expect.any(Function),
    );
  });

  it("validates Content-Type via fetchFileToBuffer hook before buffering non-document responses", async () => {
    mocks.fetchFileToBuffer.mockImplementationOnce(
      async (_url, _skipTls, _init, _maxSize, validateResponse) => {
        const fakeResponse = {
          url: "https://example.com/not-a-doc",
          status: 200,
          headers: new Headers({ "Content-Type": "application/octet-stream" }),
        };
        await validateResponse(fakeResponse);
        throw new Error("should have rejected before reading response body");
      },
    );

    await expect(
      scrapeDocument(makeMeta("https://example.com/not-a-doc")),
    ).rejects.toBeInstanceOf(DocumentAntibotError);

    mocks.fetchFileToBuffer.mockImplementationOnce(
      async (_url, _skipTls, _init, _maxSize, validateResponse) => {
        const fakeResponse = {
          url: "https://example.com/html-page",
          status: 200,
          headers: new Headers({ "Content-Type": "text/html" }),
        };
        await validateResponse(fakeResponse);
        throw new Error("should have rejected before reading response body");
      },
    );
    const nonDocumentFlagMeta = makeMeta("https://example.com/html-page");
    nonDocumentFlagMeta.featureFlags = new Set();
    await expect(scrapeDocument(nonDocumentFlagMeta)).rejects.toBeInstanceOf(
      EngineUnsuccessfulError,
    );
  });

  it("cancels the response stream in real fetchFileToBuffer when validateResponse rejects", async () => {
    const { fetchFileToBuffer: realFetchFileToBuffer } = await vi.importActual<
      typeof import("../utils/downloadFile")
    >("../utils/downloadFile");
    const undici = await import("undici");
    let bodyRead = false;
    let bodyCancelled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull() {
          bodyRead = true;
          throw new Error("should not pull body chunks");
        },
        cancel() {
          bodyCancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    mocks.undiciFetch.mockResolvedValueOnce({
      url: "https://example.com/binary",
      status: 200,
      headers: new undici.Headers({
        "content-type": "application/octet-stream",
      }),
      body: stream as any,
    } as any);
    await expect(
      realFetchFileToBuffer(
        "https://example.com/binary",
        false,
        undefined,
        DOCUMENT_MAX_FILE_BYTES,
        res => {
          if (res.headers.get("content-type") === "application/octet-stream") {
            throw new DocumentAntibotError();
          }
        },
      ),
    ).rejects.toBeInstanceOf(DocumentAntibotError);
    expect(bodyRead).toBe(false);
    expect(bodyCancelled).toBe(true);
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
