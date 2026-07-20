import { describe, it, expect } from "vitest";
import { decodeHtmlBuffer } from "./decodeHtmlBuffer";

describe("decodeHtmlBuffer", () => {
  it("decodes UTF-8 by default when no charset is specified", () => {
    const buf = Buffer.from("hello world", "utf8");
    const result = decodeHtmlBuffer(buf);
    expect(result.text).toBe("hello world");
    expect(result.charset).toBeUndefined();
  });

  it("decodes Shift_JIS from Content-Type header", () => {
    // "こんにちは" in Shift_JIS
    const buf = Buffer.from([0x82, 0xb1, 0x82, 0xf1, 0x82, 0xc9, 0x82, 0xbf, 0x82, 0xcd]);
    const result = decodeHtmlBuffer(buf, "text/html; charset=Shift_JIS");
    expect(result.text).toBe("こんにちは");
    expect(result.charset).toBe("Shift_JIS");
    expect(result.charsetSource).toBe("header");
  });

  it("decodes EUC-KR from Content-Type header", () => {
    // "안녕하세요" in EUC-KR
    const buf = Buffer.from([0xbe, 0xc8, 0xb3, 0xe7, 0xc7, 0xcf, 0xbc, 0xbc, 0xbf, 0xe4]);
    const result = decodeHtmlBuffer(buf, "text/html; charset=EUC-KR");
    expect(result.text).toBe("안녕하세요");
    expect(result.charset).toBe("EUC-KR");
    expect(result.charsetSource).toBe("header");
  });

  it("decodes GBK from Content-Type header", () => {
    // "你好" in GBK
    const buf = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]);
    const result = decodeHtmlBuffer(buf, "text/html; charset=GBK");
    expect(result.text).toBe("你好");
    expect(result.charset).toBe("GBK");
    expect(result.charsetSource).toBe("header");
  });

  it("decodes windows-1251 (Cyrillic) from Content-Type header", () => {
    // "Привет" in windows-1251
    const buf = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);
    const result = decodeHtmlBuffer(buf, "text/html; charset=windows-1251");
    expect(result.text).toBe("Привет");
    expect(result.charset).toBe("windows-1251");
    expect(result.charsetSource).toBe("header");
  });

  it("falls back to meta charset when header charset is unsupported", () => {
    const html = '<html><head><meta charset="Shift_JIS"></head><body>test</body></html>';
    const buf = Buffer.from(html, "utf8");
    const result = decodeHtmlBuffer(buf, "text/html; charset=invalid-charset");
    // Should fall back to meta charset
    expect(result.charset).toBe("Shift_JIS");
    expect(result.charsetSource).toBe("meta");
  });

  it("detects charset from meta tag when no Content-Type charset", () => {
    const html = '<html><head><meta charset="utf-8"></head><body>hello</body></html>';
    const buf = Buffer.from(html, "utf8");
    const result = decodeHtmlBuffer(buf, "text/html");
    expect(result.charset).toBe("utf-8");
    expect(result.charsetSource).toBe("meta");
  });

  it("falls back to UTF-8 when no charset is detected", () => {
    const buf = Buffer.from("plain text", "utf8");
    const result = decodeHtmlBuffer(buf, "text/html");
    expect(result.text).toBe("plain text");
    expect(result.charset).toBeUndefined();
  });

  // --- Regression tests for cubic-dev-ai P2 review findings ---

  it("does not match charset= inside unrelated attribute values", () => {
    // A <meta> tag with an unrelated data-* attribute containing "charset="
    // should not be treated as a charset declaration.
    const html =
      '<html><head><meta name="foo" data-charset="latin1"></head><body>héllo</body></html>';
    const buf = Buffer.from(html, "utf8");
    const result = decodeHtmlBuffer(buf, "text/html");
    expect(result.charset).toBeUndefined();
    expect(result.text).toContain("héllo");
  });

  it("does not match charset= inside body or script content", () => {
    const html =
      '<html><head></head><body><script>var x = "charset=latin1";</script>héllo</body></html>';
    const buf = Buffer.from(html, "utf8");
    const result = decodeHtmlBuffer(buf, "text/html");
    expect(result.charset).toBeUndefined();
    expect(result.text).toContain("héllo");
  });

  it("limits meta scan to the first 1024 bytes (prologue)", () => {
    // A meta charset tag appearing after the first 1024 bytes should be ignored.
    const padding = "x".repeat(1100);
    const html = `${padding}<meta charset="latin1">héllo`;
    const buf = Buffer.from(html, "latin1");
    const result = decodeHtmlBuffer(buf, "text/html");
    // Should fall back to UTF-8, not detect latin1 from the late meta tag
    expect(result.charset).toBeUndefined();
    expect(result.charsetSource).toBeUndefined();
  });

  it("detects charset from <meta http-equiv content-type> in prologue", () => {
    const html =
      '<html><head><meta http-equiv="content-type" content="text/html; charset=latin1"></head><body>héllo</body></html>';
    const buf = Buffer.from(html, "latin1");
    const result = decodeHtmlBuffer(buf, "text/html");
    expect(result.charset).toBe("latin1");
    expect(result.charsetSource).toBe("meta");
    expect(result.text).toContain("héllo");
  });
});