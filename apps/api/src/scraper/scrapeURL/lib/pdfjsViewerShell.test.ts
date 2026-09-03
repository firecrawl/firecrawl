import { describe, expect, it } from "vitest";
import {
  detectPdfJsViewerShell,
  locatePdfJsViewerDocument,
  MAX_HOST_TEXT_LENGTH,
} from "./pdfjsViewerShell";

const VIEWER_URL = "https://archive.example.org/pdfjs/web/viewer.html";

/**
 * The stock viewer as a browser returns it after pdf.js localized its
 * toolbar: the structure of Mozilla's viewer.html plus the visible strings
 * the l10n pass inserts. With stylesheets blocked (our default) the viewer
 * never initializes, so no page or text layer ever appears — this is the
 * whole document a scrape used to return.
 */
function stockViewer(extraHead = ""): string {
  return `<!DOCTYPE html>
<html dir="ltr" mozdisallowselectionprint>
<head>
<meta charset="utf-8">
<title>PDF.js viewer</title>
<link rel="stylesheet" href="viewer.css">
<script src="../build/pdf.mjs" type="module"></script>
<script src="viewer.mjs" type="module"></script>
${extraHead}
</head>
<body tabindex="0">
<div id="outerContainer">
  <div id="sidebarContainer">
    <div id="toolbarSidebar">
      <button id="viewThumbnail" data-l10n-id="pdfjs-thumbs-button" title="Show Thumbnails">
        <span data-l10n-id="pdfjs-thumbs-button-label">Thumbnails</span>
      </button>
      <button id="viewOutline" data-l10n-id="pdfjs-document-outline-button" title="Show Document Outline">
        <span data-l10n-id="pdfjs-document-outline-button-label">Document Outline</span>
      </button>
      <button id="viewAttachments" data-l10n-id="pdfjs-attachments-button" title="Show Attachments">
        <span data-l10n-id="pdfjs-attachments-button-label">Attachments</span>
      </button>
      <button id="viewLayers" data-l10n-id="pdfjs-layers-button" title="Show Layers">
        <span data-l10n-id="pdfjs-layers-button-label">Layers</span>
      </button>
    </div>
  </div>
  <div id="mainContainer">
    <div class="toolbar">
      <div id="toolbarContainer">
        <div id="toolbarViewer">
          <button id="zoomOutButton" data-l10n-id="pdfjs-zoom-out-button" title="Zoom Out"><span>Zoom Out</span></button>
          <button id="zoomInButton" data-l10n-id="pdfjs-zoom-in-button" title="Zoom In"><span>Zoom In</span></button>
          <select id="scaleSelect" data-l10n-id="pdfjs-zoom-select">
            <option value="auto" data-l10n-id="pdfjs-page-scale-auto">Automatic Zoom</option>
            <option value="page-actual" data-l10n-id="pdfjs-page-scale-actual">Actual Size</option>
            <option value="page-fit" data-l10n-id="pdfjs-page-scale-fit">Page Fit</option>
            <option value="page-width" data-l10n-id="pdfjs-page-scale-width">Page Width</option>
          </select>
          <button id="presentationMode" data-l10n-id="pdfjs-presentation-mode-button"><span>Presentation Mode</span></button>
          <button id="documentProperties" data-l10n-id="pdfjs-document-properties-button"><span>Document Properties</span></button>
        </div>
      </div>
    </div>
    <div id="viewerContainer" tabindex="0">
      <div id="viewer" class="pdfViewer"></div>
    </div>
  </div>
</div>
<div id="printContainer"></div>
</body>
</html>`;
}

/**
 * A custom build: a product's own document page around pdfjs-dist, with the
 * document fetched by a script the page does not spell out.
 */
const CUSTOM_BUILD = `<!DOCTYPE html>
<html lang="en">
<head>
<title>Document viewer</title>
<link rel="stylesheet" href="/static/pdfjs-dist/web/pdf_viewer.css">
<script src="/static/pdfjs-dist/build/pdf.min.js"></script>
</head>
<body>
<header><h1>Records Office</h1><button id="download">Download</button></header>
<div id="viewerContainer"><div id="viewer" class="pdfViewer"></div></div>
<script>
  const endpoint = document.body.dataset.endpoint;
  pdfjsLib.GlobalWorkerOptions.workerSrc = "/static/pdfjs-dist/build/pdf.worker.min.js";
  fetch(endpoint).then(r => r.arrayBuffer()).then(data => {
    pdfjsLib.getDocument({ data }).promise.then(pdf => render(pdf));
  });
</script>
</body>
</html>`;

const ARTICLE_BODY = Array.from(
  { length: 30 },
  (_, i) =>
    `<p>Paragraph ${i}: rendering documents in the browser is a common requirement, and this article walks through the trade-offs of the available approaches in some depth.</p>`,
).join("\n");

/** A blog post about pdf.js: it mentions the library, it is not the viewer. */
const ARTICLE_ABOUT_PDFJS = `<!DOCTYPE html>
<html lang="en">
<head>
<title>Rendering PDFs in the browser with pdf.js</title>
<script src="/js/vendor/pdfjs-dist/build/pdf.min.js"></script>
</head>
<body>
<article>
<h1>Rendering PDFs in the browser with pdf.js</h1>
<p>Mozilla's viewer exposes a global called PDFViewerApplication that you can drive from the console.</p>
${ARTICLE_BODY}
</article>
</body>
</html>`;

/** Documentation that embeds a viewer among its own content. */
const DOCS_WITH_EMBEDDED_VIEWER = `<!DOCTYPE html>
<html lang="en">
<head>
<title>Installation guide</title>
<script src="/vendor/pdfjs-dist/build/pdf.min.js"></script>
</head>
<body>
<main>
<h1>Installation guide</h1>
${ARTICLE_BODY}
<h2>Datasheet</h2>
<div id="viewerContainer"><div id="viewer" class="pdfViewer"></div></div>
</main>
</body>
</html>`;

describe("detectPdfJsViewerShell", () => {
  it("recognizes the stock viewer as rendered by the browser", () => {
    const shell = detectPdfJsViewerShell(stockViewer(), VIEWER_URL);
    expect(shell).not.toBeNull();
    expect(shell!.kind).toBe("pdfjs-viewer");
    expect(shell!.signals).toEqual(
      expect.arrayContaining([
        "title",
        "html-attributes",
        "containers",
        "scripts",
        "l10n",
        "toolbar",
      ]),
    );
    // The bare viewer loads a default document the page does not name.
    expect(shell!.document).toBeNull();
  });

  it("recognizes the stock viewer before localization (raw HTML)", () => {
    // What a non-JS engine sees: l10n ids present, visible strings absent.
    const raw = stockViewer()
      .replace(/>Thumbnails</g, "><")
      .replace(/>Document Outline</g, "><")
      .replace(/>Attachments</g, "><")
      .replace(/>Layers</g, "><")
      .replace(/<span>[^<]*<\/span>/g, "<span></span>")
      .replace(/<option([^>]*)>[^<]*<\/option>/g, "<option$1></option>")
      .replace(/ title="[^"]*"/g, "");
    expect(raw).not.toContain("Automatic Zoom");
    const shell = detectPdfJsViewerShell(raw, VIEWER_URL);
    expect(shell).not.toBeNull();
    expect(shell!.signals).toEqual(
      expect.arrayContaining([
        "title",
        "html-attributes",
        "containers",
        "l10n",
      ]),
    );
    // Unlocalized markup carries no visible toolbar text: the vocabulary
    // signal must come from strings, never from ids or l10n keys.
    expect(shell!.signals).not.toContain("toolbar");
  });

  it("leaves a pdfjs-dist build the resolver could not open alone", () => {
    // Small host page, library markers, but no PDFViewerApplication and no
    // document the page names: nothing to resolve, so it is not a shell and
    // the scrape returns its HTML as before.
    expect(
      detectPdfJsViewerShell(
        CUSTOM_BUILD,
        "https://records.example.org/view/42",
      ),
    ).toBeNull();
  });

  it("leaves an unnamed custom build alone even when it borrows stock strings", () => {
    // A title and toolbar vocabulary can be copied into any build; without
    // PDFViewerApplication or the stock viewer's own markup there is nothing
    // the resolver can drive, so the page is not classified.
    const dressedUp = CUSTOM_BUILD.replace(
      "<title>Document viewer</title>",
      "<title>PDF Viewer</title>",
    ).replace(
      "<header>",
      "<header><nav>Zoom In Zoom Out Automatic Zoom Page Fit Page Width Presentation Mode</nav>",
    );
    expect(
      detectPdfJsViewerShell(dressedUp, "https://records.example.org/view/42"),
    ).toBeNull();
  });

  it("does not take PDFViewerApplicationOptions for the application itself", () => {
    const configured = CUSTOM_BUILD.replace(
      "</body>",
      '<script>PDFViewerApplicationOptions.set("workerSrc", "/static/pdfjs-dist/build/pdf.worker.min.js");</script></body>',
    );
    expect(
      detectPdfJsViewerShell(configured, "https://records.example.org/view/42"),
    ).toBeNull();
  });

  it("recognizes a custom build that names its document", () => {
    const shell = detectPdfJsViewerShell(
      CUSTOM_BUILD.replace(
        "pdfjsLib.getDocument({ data })",
        'pdfjsLib.getDocument("statement.pdf")',
      ),
      "https://records.example.org/view/42",
    );
    expect(shell).not.toBeNull();
    expect(shell!.signals).toEqual(
      expect.arrayContaining(["containers", "scripts", "pdfjs-lib"]),
    );
    expect(shell!.document).toEqual({
      url: "https://records.example.org/view/statement.pdf",
      source: "script",
    });
  });

  it("recognizes a custom build driven through PDFViewerApplication", () => {
    const shell = detectPdfJsViewerShell(
      CUSTOM_BUILD.replace(
        "</body>",
        "<script>PDFViewerApplication.open({ url: endpoint });</script></body>",
      ),
      "https://records.example.org/view/42",
    );
    expect(shell).not.toBeNull();
    expect(shell!.signals).toEqual(expect.arrayContaining(["runtime-api"]));
    // The endpoint lives in a variable: the in-page probe has to fetch it.
    expect(shell!.document).toBeNull();
  });

  it("classifies by the host text a viewer page carries, up to the limit", () => {
    // The stock viewer has no text of its own outside the widgets, so a
    // header of exactly N characters is the page's whole host text.
    const withHostText = (chars: number) =>
      stockViewer().replace(
        '<body tabindex="0">',
        `<body tabindex="0"><header><p>${"a".repeat(chars)}</p></header>`,
      );
    expect(
      detectPdfJsViewerShell(withHostText(MAX_HOST_TEXT_LENGTH), VIEWER_URL),
    ).not.toBeNull();
    expect(
      detectPdfJsViewerShell(
        withHostText(MAX_HOST_TEXT_LENGTH + 1),
        VIEWER_URL,
      ),
    ).toBeNull();
  });

  it("reads the standard viewer's file= parameter as the document", () => {
    const shell = detectPdfJsViewerShell(
      stockViewer(),
      `${VIEWER_URL}?file=%2Fdocs%2Fannual-report.pdf#page=2`,
    );
    expect(shell?.document).toEqual({
      url: "https://archive.example.org/docs/annual-report.pdf",
      source: "query",
    });
  });

  it("still classifies an old-style build that names its document", () => {
    // Older viewer.html: no pdfjs- l10n ids, no moz attributes, assets named
    // viewer.js/viewer.css, and none of the tokens the newer markup carries.
    // Title, toolbar strings and a file= parameter are all it offers, and
    // that must be enough to reach the signal pass.
    const oldStyle = `<!DOCTYPE html>
<html>
<head>
<title>PDF Viewer</title>
<link rel="stylesheet" href="viewer.css">
<script src="viewer.js"></script>
</head>
<body>
<div id="toolbarContainer">
  <button title="Zoom Out">Zoom Out</button>
  <button title="Zoom In">Zoom In</button>
  <select><option>Page Fit</option><option>Page Width</option><option>Actual Size</option></select>
  <button>Presentation Mode</button>
</div>
<div id="viewer" class="pdfViewer"></div>
</body>
</html>`;
    const shell = detectPdfJsViewerShell(
      oldStyle,
      "https://archive.example.org/legacy/web/viewer.html?file=%2Fdocs%2Fold.pdf",
    );
    expect(shell).not.toBeNull();
    expect(shell!.signals).toEqual(
      expect.arrayContaining(["title", "containers", "scripts", "toolbar"]),
    );
    expect(shell!.document).toEqual({
      url: "https://archive.example.org/docs/old.pdf",
      source: "query",
    });
  });

  it("does not count lazy-loading hints on script and link tags as assets", () => {
    const lazy = stockViewer()
      .replace(
        '<link rel="stylesheet" href="viewer.css">',
        '<link rel="stylesheet" data-href="viewer.css">',
      )
      .replace(
        '<script src="../build/pdf.mjs" type="module"></script>',
        '<script data-src="../build/pdf.mjs" type="module"></script>',
      )
      .replace(
        '<script src="viewer.mjs" type="module"></script>',
        '<script data-src="viewer.mjs" type="module"></script>',
      );
    const shell = detectPdfJsViewerShell(lazy, VIEWER_URL);
    // Still the stock viewer by its markup, but no asset was actually loaded.
    expect(shell).not.toBeNull();
    expect(shell!.signals).not.toContain("scripts");
  });

  it("does not classify a page that merely mentions pdf.js", () => {
    expect(
      detectPdfJsViewerShell(
        ARTICLE_ABOUT_PDFJS,
        "https://blog.example.com/pdfjs",
      ),
    ).toBeNull();
  });

  it("does not classify a content page that embeds a viewer", () => {
    expect(
      detectPdfJsViewerShell(
        DOCS_WITH_EMBEDDED_VIEWER,
        "https://docs.example.com/install",
      ),
    ).toBeNull();
  });

  it("requires more than one signal", () => {
    const titleOnly = `<html><head><title>PDF Viewer</title></head><body><p>Upload a file to view it.</p></body></html>`;
    expect(
      detectPdfJsViewerShell(titleOnly, "https://tools.example.com/pdf"),
    ).toBeNull();
    const scriptOnly = `<html><head><script src="/vendor/pdfjs-dist/build/pdf.min.js"></script></head><body><canvas id="c"></canvas></body></html>`;
    expect(
      detectPdfJsViewerShell(scriptOnly, "https://tools.example.com/pdf"),
    ).toBeNull();
  });

  it("ignores empty and oversized bodies", () => {
    expect(detectPdfJsViewerShell("", VIEWER_URL)).toBeNull();
    const huge = stockViewer() + "<!--" + "x".repeat(5 * 1024 * 1024) + "-->";
    expect(detectPdfJsViewerShell(huge, VIEWER_URL)).toBeNull();
  });
});

describe("locatePdfJsViewerDocument", () => {
  const page = (body: string) => `<html><body>${body}</body></html>`;

  it("resolves a relative file= parameter against the viewer URL", () => {
    expect(
      locatePdfJsViewerDocument(
        stockViewer(),
        "https://mozilla.github.io/pdf.js/web/viewer.html?file=compressed.tracemonkey-pldi-09.pdf",
      ),
    ).toEqual({
      url: "https://mozilla.github.io/pdf.js/web/compressed.tracemonkey-pldi-09.pdf",
      source: "query",
    });
  });

  it("rejects non-http document locations", () => {
    expect(
      locatePdfJsViewerDocument(
        stockViewer(),
        `${VIEWER_URL}?file=blob:https://archive.example.org/3f1c`,
      ),
    ).toBeNull();
    expect(
      locatePdfJsViewerDocument(
        page(
          `<script>PDFViewerApplication.open("data:application/pdf;base64,JVBERi0=")</script>`,
        ),
        VIEWER_URL,
      ),
    ).toBeNull();
  });

  it.each([
    [
      `<script>PDFViewerApplication.open({ url: "/files/a.pdf" });</script>`,
      "https://archive.example.org/files/a.pdf",
    ],
    [
      `<script>PDFViewerApplication.open('https://cdn.example.net/x.pdf')</script>`,
      "https://cdn.example.net/x.pdf",
    ],
    [
      `<script>var DEFAULT_URL = "../pdfs/b.pdf";</script>`,
      "https://archive.example.org/pdfjs/pdfs/b.pdf",
    ],
    [
      `<script>PDFViewerApplicationOptions.set("defaultUrl", "c.pdf");</script>`,
      "https://archive.example.org/pdfjs/web/c.pdf",
    ],
    [
      `<script>const task = pdfjsLib.getDocument("d.pdf");</script>`,
      "https://archive.example.org/pdfjs/web/d.pdf",
    ],
    [
      `<script>pdfjsLib.getDocument({ url: 'e.pdf', withCredentials: true })</script>`,
      "https://archive.example.org/pdfjs/web/e.pdf",
    ],
  ])("finds a literal document URL in a script: %s", (script, expected) => {
    expect(locatePdfJsViewerDocument(page(script), VIEWER_URL)).toEqual({
      url: expected,
      source: "script",
    });
  });

  it("leaves template expressions and variables alone", () => {
    expect(
      locatePdfJsViewerDocument(
        page(
          "<script>pdfjsLib.getDocument(`${base}/x.pdf`); PDFViewerApplication.open({ url: endpoint });</script>",
        ),
        VIEWER_URL,
      ),
    ).toBeNull();
  });

  it.each([
    [
      `<embed src="/doc.pdf?a=1&amp;b=2" type="application/pdf">`,
      "https://archive.example.org/doc.pdf?a=1&b=2",
    ],
    [
      `<object data="doc.pdf"></object>`,
      "https://archive.example.org/pdfjs/web/doc.pdf",
    ],
    [
      `<iframe src="/pdfjs/web/viewer.html?file=%2Fdocs%2Fnested.pdf"></iframe>`,
      "https://archive.example.org/docs/nested.pdf",
    ],
  ])("finds the document behind an embed: %s", (tag, expected) => {
    expect(locatePdfJsViewerDocument(page(tag), VIEWER_URL)).toEqual({
      url: expected,
      source: "embed",
    });
  });

  it("does not read file= from a frame that is not a viewer", () => {
    expect(
      locatePdfJsViewerDocument(
        page(
          `<iframe src="https://forms.example.com/upload?file=report.pdf"></iframe>`,
        ),
        VIEWER_URL,
      ),
    ).toBeNull();
  });

  it("ignores lazy-loading hints that are not the displayed document", () => {
    expect(
      locatePdfJsViewerDocument(
        page(`<iframe data-src="/lazy/preview.pdf"></iframe>`),
        VIEWER_URL,
      ),
    ).toBeNull();
  });

  it("returns null when the page does not name a document", () => {
    expect(
      locatePdfJsViewerDocument(
        page(`<iframe src="https://www.youtube.com/embed/x"></iframe>`),
        VIEWER_URL,
      ),
    ).toBeNull();
    expect(locatePdfJsViewerDocument(CUSTOM_BUILD, VIEWER_URL)).toBeNull();
  });
});
