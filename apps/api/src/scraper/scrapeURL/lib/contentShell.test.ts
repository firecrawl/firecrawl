import { describe, expect, it } from "vitest";
import { detectContentShell, wantsPageContent } from "./contentShell";

const SHELL = `<!DOCTYPE html>
<html dir="ltr" mozdisallowselectionprint>
<head><title>PDF Viewer</title><script src="/pdfjs/build/pdf.min.js"></script></head>
<body><div id="outerContainer"><div id="viewerContainer"><div id="viewer" class="pdfViewer"></div></div></div></body>
</html>`;

describe("detectContentShell", () => {
  it("recognizes a shell in an HTML result", () => {
    const shell = detectContentShell({
      html: SHELL,
      url: "https://archive.example.org/render?token=t",
      contentType: "text/html; charset=utf-8",
    });
    expect(shell?.kind).toBe("pdfjs-viewer");
  });

  it("assumes HTML when the engine reported no content type", () => {
    expect(
      detectContentShell({
        html: SHELL,
        url: "https://archive.example.org/render",
        contentType: undefined,
      }),
    ).not.toBeNull();
  });

  it("leaves non-HTML results alone", () => {
    // The pdf engine's result is the parsed document, whatever it says.
    expect(
      detectContentShell({
        html: SHELL,
        url: "https://archive.example.org/doc.pdf",
        contentType: "application/pdf",
      }),
    ).toBeNull();
    expect(
      detectContentShell({
        html: "",
        url: "https://archive.example.org/render",
        contentType: "text/html",
      }),
    ).toBeNull();
  });
});

describe("wantsPageContent", () => {
  it("is true for the default and for any content format", () => {
    expect(wantsPageContent(undefined)).toBe(true);
    expect(wantsPageContent([])).toBe(true);
    expect(wantsPageContent([{ type: "markdown" }])).toBe(true);
    expect(
      wantsPageContent([
        { type: "screenshot", fullPage: false },
        { type: "links" },
      ]),
    ).toBe(true);
  });

  it("is false when only the rendered page is wanted", () => {
    expect(wantsPageContent([{ type: "screenshot", fullPage: false }])).toBe(
      false,
    );
    expect(
      wantsPageContent([
        { type: "screenshot", fullPage: true },
        { type: "branding" },
      ]),
    ).toBe(false);
  });
});
