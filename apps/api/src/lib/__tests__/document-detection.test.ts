import {
  isDocumentContentType,
  isDocumentUrl,
  requestLooksLikeDocument,
} from "../document-detection";

describe("isDocumentContentType", () => {
  it("matches pdf and office document content types (with parameters)", () => {
    expect(isDocumentContentType("application/pdf")).toBe(true);
    expect(isDocumentContentType("application/pdf; charset=binary")).toBe(true);
    expect(
      isDocumentContentType(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe(true);
    expect(isDocumentContentType("application/vnd.ms-excel")).toBe(true);
    expect(isDocumentContentType("APPLICATION/MSWORD")).toBe(true);
  });

  it("does not match html or missing content types", () => {
    expect(isDocumentContentType("text/html; charset=utf-8")).toBe(false);
    expect(isDocumentContentType(undefined)).toBe(false);
    expect(isDocumentContentType(null)).toBe(false);
    expect(isDocumentContentType("")).toBe(false);
  });
});

describe("isDocumentUrl", () => {
  it("detects document extensions, including path-embedded and cased", () => {
    expect(isDocumentUrl("https://example.com/a.pdf")).toBe(true);
    expect(isDocumentUrl("https://example.com/a.PDF")).toBe(true);
    expect(isDocumentUrl("https://example.com/report.docx?x=1")).toBe(true);
    expect(isDocumentUrl("https://example.com/a.pdf/preview")).toBe(true);
    expect(isDocumentUrl("https://example.com/sheet.xlsx")).toBe(true);
  });

  it("returns false for html urls and unparsable input", () => {
    expect(isDocumentUrl("https://example.com/article")).toBe(false);
    expect(isDocumentUrl("https://example.com/pdf-guide")).toBe(false);
    expect(isDocumentUrl("not a url")).toBe(false);
  });
});

describe("requestLooksLikeDocument", () => {
  it("inspects url and urls fields", () => {
    expect(requestLooksLikeDocument({ url: "https://x.com/a.pdf" })).toBe(true);
    expect(
      requestLooksLikeDocument({
        urls: ["https://x.com/p", "https://x.com/a.rtf"],
      }),
    ).toBe(true);
    expect(requestLooksLikeDocument({ url: "https://x.com/page" })).toBe(false);
    expect(requestLooksLikeDocument({ urls: ["https://x.com/page"] })).toBe(
      false,
    );
    expect(requestLooksLikeDocument(undefined)).toBe(false);
    expect(requestLooksLikeDocument({})).toBe(false);
  });
});
