import { getUnsupportedParseOptionError } from "../parse";

const base = {
  formats: [{ type: "blocks" }],
} as any;

describe("parse: blocks format gating", () => {
  it("rejects blocks for non-PDF uploads", () => {
    expect(
      getUnsupportedParseOptionError({
        ...base,
        file: { kind: "document" },
      }),
    ).toMatch(/blocks format is only supported for PDF/);
    expect(
      getUnsupportedParseOptionError({
        ...base,
        file: { kind: "html" },
      }),
    ).toMatch(/blocks format is only supported for PDF/);
  });

  it("allows blocks for PDF uploads", () => {
    expect(
      getUnsupportedParseOptionError({
        ...base,
        file: { kind: "pdf" },
      }),
    ).toBeNull();
  });

  it("does not reject when blocks not requested", () => {
    expect(
      getUnsupportedParseOptionError({
        formats: [{ type: "markdown" }],
        file: { kind: "document" },
      } as any),
    ).toBeNull();
  });
});
