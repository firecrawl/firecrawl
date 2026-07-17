import { describe, it, expect } from "vitest";
import { decodeHtmlBuffer } from "../decodeHtmlBuffer";

describe("decodeHtmlBuffer", () => {
  it("decodes a Shift_JIS body using the Content-Type header charset", () => {
    // "日本語" encoded as Shift_JIS.
    const buf = Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]);

    // The old fire-engine behavior (naive UTF-8) produced mojibake, not the
    // correct text — this asserts the bug the fix addresses.
    expect(buf.toString("utf8")).not.toBe("日本語");

    const { text, charset, charsetSource } = decodeHtmlBuffer(
      buf,
      "text/html; charset=Shift_JIS",
    );
    expect(text).toBe("日本語");
    expect(charset).toBe("Shift_JIS");
    expect(charsetSource).toBe("header");
  });

  it("falls back to the <meta charset> tag when no header charset is present", () => {
    // "Привет" encoded as windows-1251, inside HTML that declares the charset.
    const cyrillic = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);
    const buf = Buffer.concat([
      Buffer.from('<meta charset="windows-1251">', "latin1"),
      cyrillic,
    ]);

    expect(buf.toString("utf8")).not.toContain("Привет");

    const { text, charset, charsetSource } = decodeHtmlBuffer(buf, undefined);
    expect(text).toContain("Привет");
    expect(charset).toBe("windows-1251");
    expect(charsetSource).toBe("meta");
  });

  it("defaults to UTF-8 when no charset is declared anywhere", () => {
    const buf = Buffer.from("hello 日本語", "utf8");
    const { text, charset, charsetSource } = decodeHtmlBuffer(buf, undefined);
    expect(text).toBe("hello 日本語");
    expect(charset).toBeUndefined();
    expect(charsetSource).toBeUndefined();
  });

  it("ignores a non-charset Content-Type parameter that merely ends in 'charset'", () => {
    // A parameter like `x-charset=` must not be treated as a charset
    // declaration, otherwise UTF-8 content would be corrupted.
    const buf = Buffer.from("hello 日本語", "utf8");
    const { text, charset } = decodeHtmlBuffer(
      buf,
      "text/html; x-charset=Shift_JIS",
    );
    expect(text).toBe("hello 日本語");
    expect(charset).toBeUndefined();
  });

  it("ignores a <meta> attribute that merely ends in 'charset'", () => {
    // `data-charset` is a different attribute and must not drive decoding.
    const buf = Buffer.concat([
      Buffer.from('<meta data-charset="windows-1251">hello 日本語', "utf8"),
    ]);
    const { text, charset } = decodeHtmlBuffer(buf, undefined);
    expect(text).toContain("日本語");
    expect(charset).toBeUndefined();
  });
});
