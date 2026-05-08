import { extractEmbeddedPdfUrl } from "../pdfUtils";

const BASE = "https://www.example.com/page";

describe("extractEmbeddedPdfUrl", () => {
  it("finds a PDF in an <iframe src>", () => {
    const html = `<html><body><iframe src="/assets/doc.pdf"></iframe></body></html>`;
    expect(extractEmbeddedPdfUrl(html, BASE)).toBe(
      "https://www.example.com/assets/doc.pdf",
    );
  });

  it("finds a PDF in an <embed src>", () => {
    const html = `<embed src="https://cdn.example.com/file.pdf" type="application/pdf">`;
    expect(extractEmbeddedPdfUrl(html, BASE)).toBe(
      "https://cdn.example.com/file.pdf",
    );
  });

  it("finds a PDF in an <object data>", () => {
    const html = `<object data="/files/report.pdf?v=2" type="application/pdf"></object>`;
    expect(extractEmbeddedPdfUrl(html, BASE)).toBe(
      "https://www.example.com/files/report.pdf?v=2",
    );
  });

  it("returns null when no embedded PDF is present", () => {
    const html = `<html><body><p>No PDF here</p></body></html>`;
    expect(extractEmbeddedPdfUrl(html, BASE)).toBeNull();
  });

  it("returns null for an iframe pointing to a non-PDF URL", () => {
    const html = `<iframe src="https://example.com/page.html"></iframe>`;
    expect(extractEmbeddedPdfUrl(html, BASE)).toBeNull();
  });

  it("resolves relative URLs against the base", () => {
    const html = `<iframe src="../docs/manual.pdf"></iframe>`;
    expect(extractEmbeddedPdfUrl(html, BASE)).toBe(
      "https://www.example.com/docs/manual.pdf",
    );
  });

  it("rejects non-http/https protocols (SSRF prevention)", () => {
    expect(
      extractEmbeddedPdfUrl(`<embed src="file:///etc/passwd.pdf">`, BASE),
    ).toBeNull();
    expect(
      extractEmbeddedPdfUrl(
        `<embed src="data:application/pdf;base64,abc.pdf">`,
        BASE,
      ),
    ).toBeNull();
  });
});
