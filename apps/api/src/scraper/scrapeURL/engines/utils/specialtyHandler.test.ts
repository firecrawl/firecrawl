import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile, unlink } from "node:fs/promises";
import { AddFeatureError, UnsupportedFileError } from "../../error";
import type { FireEngineCheckStatusSuccess } from "../fire-engine/checkStatus";

// The GCS handoff (large PDFs by reference) has its own tests under the pdf
// engine; keep the storage client out of this unit's import graph.
vi.mock("./downloadGcsFile", () => ({
  downloadFireEngineGcsFile: vi.fn(async () => null),
}));

import { specialtyScrapeCheck } from "./specialtyHandler";

const logger: any = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
};

const PDF = Buffer.from(
  "%PDF-1.3\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
);
// Leading bytes of an OOXML/ODF (ZIP) container and of a legacy Office
// (OLE2/CFB) file, padded so the payloads are longer than any signature.
const DOCX = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]),
  Buffer.alloc(64),
]);
const DOC = Buffer.concat([
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  Buffer.alloc(64),
]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64),
]);
// JPEG 2000 signature box: a real image format none of the parsers open.
const JP2 = Buffer.concat([
  Buffer.from([
    0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a,
  ]),
  Buffer.alloc(64),
]);

const DOWNLOAD_URL = "https://example.com/collection/items/42/download";

/** A chrome-cdp (or tlsclient binary) response: the file was captured. */
function download(
  bytes: Buffer,
  overrides: Partial<FireEngineCheckStatusSuccess> = {},
): FireEngineCheckStatusSuccess {
  return {
    jobId: "job-1",
    state: "completed",
    processing: false,
    content: "",
    pageStatusCode: 200,
    url: DOWNLOAD_URL,
    file: { name: "download", content: bytes.toString("base64") },
    ...overrides,
  };
}

/** A response whose body came back inline as text (no captured file). */
function inline(content: string): FireEngineCheckStatusSuccess {
  return {
    jobId: "job-1",
    state: "completed",
    processing: false,
    content,
    pageStatusCode: 200,
    url: DOWNLOAD_URL,
  };
}

const ocrGate = () => vi.fn(async () => true);

const tempFiles: string[] = [];
afterEach(async () => {
  await Promise.all(
    tempFiles.splice(0).map(file => unlink(file).catch(() => undefined)),
  );
});

async function expectHandoff(run: Promise<unknown>): Promise<AddFeatureError> {
  try {
    await run;
  } catch (error) {
    expect(error).toBeInstanceOf(AddFeatureError);
    const handoff = error as AddFeatureError;
    for (const prefetch of [
      handoff.pdfPrefetch,
      handoff.documentPrefetch,
      handoff.imagePrefetch,
    ]) {
      if (prefetch) tempFiles.push(prefetch.filePath);
    }
    return handoff;
  }
  throw new Error("expected specialtyScrapeCheck to hand the file off");
}

async function expectUnsupported(run: Promise<unknown>): Promise<string> {
  const failure = await run.then(
    () => null,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(UnsupportedFileError);
  return (failure as UnsupportedFileError).message;
}

describe("specialtyScrapeCheck: the bytes decide when the header does not", () => {
  it.each([
    "image/jp2",
    "image/jpeg",
    "application/x-download",
    "application/force-download",
    "text/plain; charset=utf-8",
  ])("hands a PDF served as %s to the pdf engine", async contentType => {
    const gate = ocrGate();
    const handoff = await expectHandoff(
      specialtyScrapeCheck(
        logger,
        { "Content-Type": contentType },
        download(PDF),
        undefined,
        undefined,
        gate,
      ),
    );

    expect(handoff.featureFlags).toEqual(["pdf"]);
    expect(handoff.pdfPrefetch).toMatchObject({
      status: 200,
      url: DOWNLOAD_URL,
      proxyUsed: "basic",
    });
    expect(handoff.pdfPrefetch!.filePath).toMatch(/\.pdf$/);
    expect(await readFile(handoff.pdfPrefetch!.filePath)).toEqual(PDF);
    expect(handoff.documentPrefetch).toBeUndefined();
    expect(handoff.imagePrefetch).toBeUndefined();
    // Not a raster image, so the per-team OCR gate is never consulted.
    expect(gate).not.toHaveBeenCalled();
  });

  it("carries the proxy that fetched the mislabeled PDF", async () => {
    const handoff = await expectHandoff(
      specialtyScrapeCheck(
        logger,
        { "content-type": "image/jp2" },
        download(PDF, { usedMobileProxy: true }),
      ),
    );
    expect(handoff.pdfPrefetch).toMatchObject({ proxyUsed: "stealth" });
  });

  it("hands an OOXML document served as an image to the document engine", async () => {
    const handoff = await expectHandoff(
      specialtyScrapeCheck(
        logger,
        { "content-type": "image/png" },
        download(DOCX),
        undefined,
        undefined,
        ocrGate(),
      ),
    );

    expect(handoff.featureFlags).toEqual(["document"]);
    // The header is passed through as served: the document engine treats it
    // as an extension hint only and falls back to the URL and the bytes.
    expect(handoff.documentPrefetch).toMatchObject({
      status: 200,
      url: DOWNLOAD_URL,
      contentType: "image/png",
    });
    expect(await readFile(handoff.documentPrefetch!.filePath)).toEqual(DOCX);
    expect(handoff.pdfPrefetch).toBeUndefined();
    expect(handoff.imagePrefetch).toBeUndefined();
  });

  it("hands a legacy Office file to the document engine, pinning .doc URLs to Word", async () => {
    const generic = await expectHandoff(
      specialtyScrapeCheck(
        logger,
        { "content-type": "image/jp2" },
        download(DOC),
      ),
    );
    expect(generic.featureFlags).toEqual(["document"]);
    expect(generic.documentPrefetch?.contentType).toBe("image/jp2");

    const word = await expectHandoff(
      specialtyScrapeCheck(
        logger,
        { "content-type": "image/jp2" },
        download(DOC, { url: "https://example.com/files/report.doc?dl=1" }),
      ),
    );
    expect(word.featureFlags).toEqual(["document"]);
    expect(word.documentPrefetch?.contentType).toBe("application/msword");
    expect(word.documentPrefetch?.filePath).toMatch(/\.doc$/);
  });

  it("still sends a real raster image to OCR before sniffing for documents", async () => {
    const gate = ocrGate();
    const handoff = await expectHandoff(
      specialtyScrapeCheck(
        logger,
        { "content-type": "image/jp2" },
        download(PNG),
        undefined,
        undefined,
        gate,
      ),
    );

    expect(handoff.featureFlags).toEqual(["image"]);
    expect(handoff.imagePrefetch).toMatchObject({ contentType: "image/png" });
    expect(handoff.pdfPrefetch).toBeUndefined();
    expect(gate).toHaveBeenCalledTimes(1);
  });

  it("keeps rejecting an image format no parser can open", async () => {
    const gate = ocrGate();
    const message = await expectUnsupported(
      specialtyScrapeCheck(
        logger,
        { "content-type": "image/jp2" },
        download(JP2),
        undefined,
        undefined,
        gate,
      ),
    );
    expect(message).toContain("image/jp2");
    expect(gate).not.toHaveBeenCalled();
  });

  it("leaves a declared ZIP archive with the unsupported-file rejection", async () => {
    const message = await expectUnsupported(
      specialtyScrapeCheck(
        logger,
        { "content-type": "application/zip" },
        download(DOCX),
      ),
    );
    expect(message).toContain("application/zip");
  });

  it("keeps routing application/octet-stream by its bytes", async () => {
    const pdf = await expectHandoff(
      specialtyScrapeCheck(
        logger,
        { "content-type": "application/octet-stream" },
        download(PDF),
      ),
    );
    expect(pdf.featureFlags).toEqual(["pdf"]);

    const docx = await expectHandoff(
      specialtyScrapeCheck(
        logger,
        { "content-type": "application/octet-stream" },
        download(DOCX),
      ),
    );
    expect(docx.featureFlags).toEqual(["document"]);
    expect(docx.documentPrefetch?.contentType).toBe("application/octet-stream");
  });

  it("sniffs a body fire-engine returned inline as text", async () => {
    // tlsclient returns UTF-8 bodies as `content` rather than as a file. A
    // body that opens with the PDF magic is still a PDF; with nothing
    // captured the prefetch is null, so the pdf engine fetches it itself.
    const handoff = await expectHandoff(
      specialtyScrapeCheck(
        logger,
        { "content-type": "application/x-download" },
        inline("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n"),
      ),
    );
    expect(handoff.featureFlags).toEqual(["pdf"]);
    expect(handoff.pdfPrefetch).toBeNull();
  });

  it("does not sniff an ordinary rendered page", async () => {
    await expect(
      specialtyScrapeCheck(
        logger,
        { "content-type": "text/html; charset=utf-8" },
        inline("<!DOCTYPE html><html><body>PK</body></html>"),
      ),
    ).resolves.toBeUndefined();
  });

  it("does not mistake a text body that merely starts with PK for an archive", async () => {
    await expect(
      specialtyScrapeCheck(
        logger,
        { "content-type": "text/plain" },
        inline("PKI certificate bundle\n"),
      ),
    ).resolves.toBeUndefined();
  });

  it("recognizes a header-less download by its bytes", async () => {
    const pdf = await expectHandoff(
      specialtyScrapeCheck(logger, undefined, download(PDF)),
    );
    expect(pdf.featureFlags).toEqual(["pdf"]);

    const docx = await expectHandoff(
      specialtyScrapeCheck(logger, {}, download(DOCX)),
    );
    expect(docx.featureFlags).toEqual(["document"]);
    expect(docx.documentPrefetch?.contentType).toBeUndefined();
  });

  it("does nothing without a fire-engine response to sniff", async () => {
    await expect(
      specialtyScrapeCheck(logger, { "content-type": "text/html" }),
    ).resolves.toBeUndefined();
  });
});
