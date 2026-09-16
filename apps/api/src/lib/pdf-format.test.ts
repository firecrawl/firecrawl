import { describe, expect, it } from "vitest";
import {
  fromPdfHeader,
  isPdfBuffer,
  pdfHeaderOffset,
  PDF_SNIFF_WINDOW,
} from "./pdf-format";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n");
// Leading bytes as a server echoes them back from a multipart upload.
const WRAPPER = Buffer.from(
  "------------------------------1234567890\r\n" +
    'Content-Disposition: form-data; name="file"; filename="file.pdf"\r\n' +
    "Content-Type: application/pdf\r\n\r\n",
);

describe("pdfHeaderOffset", () => {
  it("finds the header at byte 0", () => {
    expect(pdfHeaderOffset(PDF)).toBe(0);
    expect(isPdfBuffer(PDF)).toBe(true);
  });

  it("finds a header behind leading bytes within the sniff window", () => {
    const wrapped = Buffer.concat([WRAPPER, PDF]);
    expect(pdfHeaderOffset(wrapped)).toBe(WRAPPER.length);
    expect(isPdfBuffer(wrapped)).toBe(true);
  });

  it("prefers the versioned header over a bare %PDF in the leading bytes", () => {
    const wrapper = Buffer.from(
      '------boundary\r\nContent-Disposition: form-data; filename="%PDF-report.pdf"\r\n\r\n',
    );
    const wrapped = Buffer.concat([wrapper, PDF]);
    expect(pdfHeaderOffset(wrapped)).toBe(wrapper.length);
    expect(fromPdfHeader(wrapped)).toEqual(PDF);
  });

  it("still accepts a bare %PDF when no versioned header follows", () => {
    expect(pdfHeaderOffset(Buffer.from("%PDF"))).toBe(0);
    expect(pdfHeaderOffset(Buffer.concat([WRAPPER, Buffer.from("%PDF")]))).toBe(
      WRAPPER.length,
    );
  });

  it("does not look past the sniff window", () => {
    const wrapped = Buffer.concat([Buffer.alloc(PDF_SNIFF_WINDOW, 0x20), PDF]);
    expect(pdfHeaderOffset(wrapped)).toBe(-1);
    expect(isPdfBuffer(wrapped)).toBe(false);
  });

  it("reports no header in a page or an empty buffer", () => {
    expect(pdfHeaderOffset(Buffer.from("<!DOCTYPE html><html></html>"))).toBe(
      -1,
    );
    expect(pdfHeaderOffset(Buffer.alloc(0))).toBe(-1);
  });
});

describe("fromPdfHeader", () => {
  it("drops leading bytes ahead of the header", () => {
    expect(fromPdfHeader(Buffer.concat([WRAPPER, PDF]))).toEqual(PDF);
  });

  it("returns the buffer unchanged when the header is at byte 0", () => {
    expect(fromPdfHeader(PDF)).toBe(PDF);
  });

  it("returns the buffer unchanged when there is no header to find", () => {
    const page = Buffer.from("<!DOCTYPE html>");
    expect(fromPdfHeader(page)).toBe(page);
  });
});
