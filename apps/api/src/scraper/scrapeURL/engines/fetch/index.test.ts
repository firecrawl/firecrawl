import { afterEach, describe, expect, it, vi } from "vitest";
import { ReadableStream } from "node:stream/web";
import * as undici from "undici";
import { AddFeatureError, UnsupportedFileError } from "../../error";

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}));

vi.mock("undici", async importOriginal => {
  const actual = await importOriginal<typeof import("undici")>();
  return {
    ...actual,
    fetch: fetchMock,
  };
});

vi.mock("../../lib/mock", () => ({
  saveMock: vi.fn(async () => undefined),
}));

vi.mock("../utils/safeFetch", () => ({
  getSecureDispatcher: vi.fn(() => undefined),
  InsecureConnectionError: class InsecureConnectionError extends Error {},
  TLS_CERT_ERROR_CODES: new Set<string>(),
}));

import { FETCH_MAX_RESPONSE_BYTES, scrapeURLWithFetch } from "./index";

const logger: any = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
};

function makeMeta(url: string): any {
  const abortController = new AbortController();
  return {
    id: "scrape-test-1",
    url,
    rewrittenUrl: undefined,
    options: {
      headers: undefined,
      skipTlsVerification: false,
    },
    abort: {
      asSignal: () => abortController.signal,
    },
    mock: null,
    fetchPrefetch: undefined,
    imageOcrEnabled: async () => false,
    logger,
  };
}

function makeStreamingResponse(opts: {
  url?: string;
  status?: number;
  headers: Record<string, string>;
  firstChunk: Uint8Array;
  onNextPull?: () => Uint8Array | never;
  onCancel?: () => void;
}): undici.Response {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulled += 1;
        if (pulled === 1) {
          controller.enqueue(opts.firstChunk);
          if (!opts.onNextPull) {
            controller.close();
          }
          return;
        }
        const next = opts.onNextPull!();
        controller.enqueue(next);
      },
      cancel() {
        opts.onCancel?.();
      },
    },
    { highWaterMark: 0 },
  );

  return {
    url: opts.url ?? "https://example.com/download",
    status: opts.status ?? 200,
    headers: new undici.Headers(opts.headers),
    body: body as any,
  } as unknown as undici.Response;
}

describe("scrapeURLWithFetch binary and size guards", () => {
  afterEach(() => {
    fetchMock.mockReset();
    vi.clearAllMocks();
  });

  it("cancels binary installer downloads on the first chunk without buffering the body", async () => {
    let cancelled = false;
    let secondChunkRead = false;
    const exeHeader = Buffer.concat([
      Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]),
      Buffer.alloc(1024, 0xaa),
    ]);

    fetchMock.mockResolvedValue(
      makeStreamingResponse({
        url: "https://release-assets.example.com/DesktopApp-Setup-1.0.0-x64.exe",
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition":
            "attachment; filename=DesktopApp-Setup-1.0.0-x64.exe",
          "content-length": "121134000",
        },
        firstChunk: exeHeader,
        onNextPull: () => {
          secondChunkRead = true;
          throw new Error("should not pull remaining 120MB installer chunks");
        },
        onCancel: () => {
          cancelled = true;
        },
      }),
    );

    await expect(
      scrapeURLWithFetch(makeMeta("https://example.com/download/windows")),
    ).rejects.toBeInstanceOf(UnsupportedFileError);

    expect(cancelled).toBe(true);
    expect(secondChunkRead).toBe(false);
  });

  it("hands off PDFs served as application/octet-stream on the first chunk without buffering the full PDF", async () => {
    let cancelled = false;
    let secondChunkRead = false;
    const pdfPrefix = Buffer.concat([
      Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\n"),
      Buffer.alloc(1024, 0x20),
    ]);

    fetchMock.mockImplementation(() =>
      Promise.resolve(
        makeStreamingResponse({
          url: "https://example.com/filing?download=1",
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(FETCH_MAX_RESPONSE_BYTES + 10_000_000),
          },
          firstChunk: pdfPrefix,
          onNextPull: () => {
            secondChunkRead = true;
            throw new Error(
              "should hand off to pdf engine before pulling rest",
            );
          },
          onCancel: () => {
            cancelled = true;
          },
        }),
      ),
    );

    await expect(
      scrapeURLWithFetch(makeMeta("https://example.com/filing?download=1")),
    ).rejects.toMatchObject({
      featureFlags: ["pdf"],
    });
    await expect(
      scrapeURLWithFetch(makeMeta("https://example.com/filing?download=1")),
    ).rejects.toBeInstanceOf(AddFeatureError);

    expect(cancelled).toBe(true);
    expect(secondChunkRead).toBe(false);
  });

  it("aborts oversized HTML responses via Content-Length or streamed byte count", async () => {
    let cancelled = false;
    fetchMock.mockResolvedValueOnce(
      makeStreamingResponse({
        url: "https://example.com/huge.html",
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-length": String(FETCH_MAX_RESPONSE_BYTES + 1),
        },
        firstChunk: Buffer.from("<!DOCTYPE html><html><body>".padEnd(600, "x")),
        onNextPull: () => {
          throw new Error("should stop after Content-Length check");
        },
        onCancel: () => {
          cancelled = true;
        },
      }),
    );

    await expect(
      scrapeURLWithFetch(makeMeta("https://example.com/huge.html")),
    ).rejects.toThrow("File exceeds size limit");
    expect(cancelled).toBe(true);

    // Chunked response without Content-Length that exceeds FETCH_MAX_RESPONSE_BYTES
    let streamCancelled = false;
    const chunk = Buffer.alloc(16 * 1024 * 1024, 0x61);
    fetchMock.mockResolvedValueOnce(
      makeStreamingResponse({
        url: "https://example.com/chunked-huge.html",
        headers: {
          "content-type": "text/html; charset=utf-8",
        },
        firstChunk: chunk,
        onNextPull: () => chunk,
        onCancel: () => {
          streamCancelled = true;
        },
      }),
    );

    await expect(
      scrapeURLWithFetch(makeMeta("https://example.com/chunked-huge.html")),
    ).rejects.toThrow("File exceeds size limit");
    expect(streamCancelled).toBe(true);
  });

  it("scrapes normal HTML responses within the size limit", async () => {
    const html = "<!DOCTYPE html><html><body><h1>Hello</h1></body></html>";
    fetchMock.mockResolvedValue(
      makeStreamingResponse({
        url: "https://example.com/",
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-length": String(Buffer.byteLength(html)),
        },
        firstChunk: Buffer.from(html),
      }),
    );

    const res = await scrapeURLWithFetch(makeMeta("https://example.com/"));
    expect(res.statusCode).toBe(200);
    expect(res.html).toBe(html);
    expect(res.contentType).toBe("text/html; charset=utf-8");
  });
});
