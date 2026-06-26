import { isPdfBuffer } from "../pdfUtils";

describe("isPdfBuffer", () => {
  it("detects a standard PDF-1.4 header", () => {
    const buf = Buffer.from("%PDF-1.4 rest of file...");
    expect(isPdfBuffer(buf)).toBe(true);
  });

  it("detects a PDF-2.0 header", () => {
    const buf = Buffer.from("%PDF-2.0\n");
    expect(isPdfBuffer(buf)).toBe(true);
  });

  it("detects %PDF with a UTF-8 BOM prefix", () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const pdf = Buffer.from("%PDF-1.7");
    expect(isPdfBuffer(Buffer.concat([bom, pdf]))).toBe(true);
  });

  it("detects %PDF preceded by whitespace/newlines", () => {
    const buf = Buffer.from("  \n\r\n%PDF-1.5 data...");
    expect(isPdfBuffer(buf)).toBe(true);
  });

  it("detects %PDF preceded by junk bytes within 1KB", () => {
    const junk = Buffer.alloc(500, 0x00);
    const pdf = Buffer.from("%PDF-1.4 rest...");
    expect(isPdfBuffer(Buffer.concat([junk, pdf]))).toBe(true);
  });

  it("rejects %PDF that appears after the 1KB window", () => {
    const padding = Buffer.alloc(1024, 0x20); // 1024 spaces
    const pdf = Buffer.from("%PDF-1.4");
    expect(isPdfBuffer(Buffer.concat([padding, pdf]))).toBe(false);
  });

  it("rejects HTML content", () => {
    const buf = Buffer.from(
      "<!DOCTYPE html><html><body>Not a PDF</body></html>",
    );
    expect(isPdfBuffer(buf)).toBe(false);
  });

  it("rejects plain text", () => {
    const buf = Buffer.from("Hello, this is just a text file.");
    expect(isPdfBuffer(buf)).toBe(false);
  });

  it("rejects an empty buffer", () => {
    expect(isPdfBuffer(Buffer.alloc(0))).toBe(false);
  });

  it("rejects a buffer shorter than the magic bytes", () => {
    const buf = Buffer.from("%PD");
    expect(isPdfBuffer(buf)).toBe(false);
  });

  it("rejects a buffer containing only part of the magic", () => {
    const buf = Buffer.from("%PD\x00\x00\x00");
    expect(isPdfBuffer(buf)).toBe(false);
  });

  it("rejects a 404 HTML error page", () => {
    const buf = Buffer.from(
      "<html><head><title>404 Not Found</title></head><body>Not Found</body></html>",
    );
    expect(isPdfBuffer(buf)).toBe(false);
  });

  it("rejects JSON response", () => {
    const buf = Buffer.from('{"error": "not found"}');
    expect(isPdfBuffer(buf)).toBe(false);
  });

  it("handles exactly 4-byte %PDF buffer", () => {
    const buf = Buffer.from("%PDF");
    expect(isPdfBuffer(buf)).toBe(true);
  });

  it("detects %PDF at the boundary of the 1KB window", () => {
    // Place %PDF so it ends exactly at byte 1024
    const padding = Buffer.alloc(1020, 0x41); // 1020 'A's
    const pdf = Buffer.from("%PDF");
    expect(isPdfBuffer(Buffer.concat([padding, pdf]))).toBe(true);
  });
});
