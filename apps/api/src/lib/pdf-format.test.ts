import { describe, expect, it } from "vitest";
import {
  fromPdfHeader,
  isPdfBuffer,
  pdfHeaderLineOffset,
  PDF_HEADER_PROBE_BYTES,
  PDF_SNIFF_WINDOW,
} from "./pdf-format";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n");
// Leading bytes as a server echoes them back from a multipart upload.
const WRAPPER = Buffer.from(
  "------------------------------1234567890\r\n" +
    'Content-Disposition: form-data; name="file"; filename="file.pdf"\r\n' +
    "Content-Type: application/pdf\r\n\r\n",
);
const PAGE = Buffer.from(
  "<!DOCTYPE html><html><body><p>%PDF-1.4 files start with %PDF</p></body></html>",
);

describe("pdfHeaderLineOffset", () => {
  it("finds the header at byte 0", () => {
    expect(pdfHeaderLineOffset(PDF)).toBe(0);
  });

  it("finds a header line behind leading bytes within the sniff window", () => {
    expect(pdfHeaderLineOffset(Buffer.concat([WRAPPER, PDF]))).toBe(
      WRAPPER.length,
    );
    expect(
      pdfHeaderLineOffset(Buffer.concat([Buffer.from("junk\n"), PDF])),
    ).toBe(5);
  });

  it("skips a mention of the magic mid-line in the leading bytes", () => {
    // A filename, even a versioned-looking one, is not the header.
    const wrapper = Buffer.from(
      '------boundary\r\nContent-Disposition: form-data; filename="%PDF-1.7 report.pdf"\r\n\r\n',
    );
    expect(pdfHeaderLineOffset(Buffer.concat([wrapper, PDF]))).toBe(
      wrapper.length,
    );
  });

  it("allows a byte-order mark ahead of the header", () => {
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), PDF]);
    expect(pdfHeaderLineOffset(bom)).toBe(3);
  });

  it("rejects a body that merely mentions the magic", () => {
    expect(pdfHeaderLineOffset(PAGE)).toBe(-1);
    expect(pdfHeaderLineOffset(Buffer.from("%PDF"))).toBe(-1);
    expect(pdfHeaderLineOffset(Buffer.from("%PDF-x"))).toBe(-1);
    // The version must end the line.
    expect(pdfHeaderLineOffset(Buffer.from("%PDF-1.4 files\n"))).toBe(-1);
    expect(pdfHeaderLineOffset(Buffer.alloc(0))).toBe(-1);
  });

  it("accepts either line ending after the version", () => {
    expect(pdfHeaderLineOffset(Buffer.from("%PDF-1.7\r\n%\xe2\xe3"))).toBe(0);
    expect(pdfHeaderLineOffset(Buffer.from("%PDF-2.0\r"))).toBe(0);
  });

  it("sees a header line whole when it starts at the end of the window", () => {
    const padding = Buffer.alloc(PDF_SNIFF_WINDOW - 4, 0x20);
    padding[padding.length - 1] = 0x0a;
    const wrapped = Buffer.concat([padding, PDF]);
    expect(pdfHeaderLineOffset(wrapped)).toBe(padding.length);
    // A probe of that many bytes is enough to make the call.
    expect(
      pdfHeaderLineOffset(wrapped.subarray(0, PDF_HEADER_PROBE_BYTES)),
    ).toBe(padding.length);
  });

  it("does not look past the sniff window", () => {
    const wrapped = Buffer.concat([Buffer.alloc(PDF_SNIFF_WINDOW, 0x20), PDF]);
    expect(pdfHeaderLineOffset(wrapped)).toBe(-1);
    // A magic cut by the window edge is no candidate for either predicate.
    const cut = Buffer.alloc(PDF_SNIFF_WINDOW - 3, 0x20);
    cut[cut.length - 1] = 0x0a;
    const straddling = Buffer.concat([cut, PDF]);
    expect(pdfHeaderLineOffset(straddling)).toBe(-1);
    expect(isPdfBuffer(straddling)).toBe(false);
  });
});

describe("isPdfBuffer", () => {
  it("stays the lenient acceptance gate", () => {
    expect(isPdfBuffer(PDF)).toBe(true);
    expect(isPdfBuffer(Buffer.concat([WRAPPER, PDF]))).toBe(true);
    expect(isPdfBuffer(Buffer.from("%PDF"))).toBe(true);
    expect(isPdfBuffer(PAGE)).toBe(true);
    expect(isPdfBuffer(Buffer.from("<!DOCTYPE html>"))).toBe(false);
  });
});

describe("fromPdfHeader", () => {
  it("drops leading bytes ahead of the header line", () => {
    expect(fromPdfHeader(Buffer.concat([WRAPPER, PDF]))).toEqual(PDF);
  });

  it("returns the buffer unchanged when the header is at byte 0", () => {
    expect(fromPdfHeader(PDF)).toBe(PDF);
  });

  it("never truncates bytes that merely mention the magic", () => {
    expect(fromPdfHeader(PAGE)).toBe(PAGE);
    const bare = Buffer.concat([WRAPPER, Buffer.from("%PDF")]);
    expect(fromPdfHeader(bare)).toBe(bare);
  });
});
