import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile, unlink } from "node:fs/promises";
import { AddFeatureError, PDFViewerUnresolvedError } from "../../../error";
import { AbortManagerThrownError } from "../../../lib/abortManager";
import type { PdfJsViewerShell } from "../../../lib/pdfjsViewerShell";
import type { FireEngineCheckStatusSuccess } from "../checkStatus";
import { resolvePdfJsViewerShell, type ChromeCdpRequest } from "../pdfjsViewer";

const logger: any = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
};

const VIEWER_URL =
  "https://archive.example.org/render/external?entityRef=abc&token=t1";
const DOCUMENT_URL =
  "https://archive.example.org/render/content?entityRef=abc&token=t1";

const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
);

const request: ChromeCdpRequest = {
  url: VIEWER_URL,
  engine: "chrome-cdp",
  timeout: 30000,
  headers: { "x-test": "1" },
  mobileProxy: false,
};

/** A chrome-cdp response for a rendered page (not a file). */
function page(
  url: string,
  status = 200,
  content = "<html><body>page</body></html>",
): FireEngineCheckStatusSuccess {
  return {
    jobId: "job-1",
    state: "completed",
    processing: false,
    content,
    pageStatusCode: status,
    url,
  };
}

/** The viewer page with the probe's executeJavascript result attached. */
function probe(
  result: object,
  overrides: Partial<FireEngineCheckStatusSuccess> = {},
): FireEngineCheckStatusSuccess {
  return {
    ...page(VIEWER_URL),
    actionResults: [
      {
        idx: 0,
        type: "executeJavascript",
        result: {
          return: JSON.stringify({
            type: "string",
            value: JSON.stringify(result),
          }),
        },
      },
    ],
    ...overrides,
  };
}

function shell(document: PdfJsViewerShell["document"]): PdfJsViewerShell {
  return { kind: "pdfjs-viewer", signals: ["title", "containers"], document };
}

/** What specialtyScrapeCheck throws when a navigation yields a PDF. */
function handoff(url: string): AddFeatureError {
  return new AddFeatureError(["pdf"], {
    filePath: "/tmp/handoff.pdf",
    url,
    status: 200,
    proxyUsed: "basic",
  });
}

type Scrape = (
  request: ChromeCdpRequest,
) => Promise<FireEngineCheckStatusSuccess>;

async function resolve(
  viewerShell: PdfJsViewerShell,
  scrapes: Scrape[],
  meta: Record<string, unknown> = {},
  shellResponse: FireEngineCheckStatusSuccess = page(VIEWER_URL),
) {
  const calls: ChromeCdpRequest[] = [];
  const performScrape = vi.fn(async (req: ChromeCdpRequest) => {
    calls.push(req);
    const next = scrapes.shift();
    if (next === undefined) throw new Error("unexpected navigation");
    return next(req);
  });
  const outcome = await resolvePdfJsViewerShell(
    {
      options: { proxy: "auto" },
      featureFlags: new Set(),
      abort: { scrapeTimeout: () => 12345 },
      ...meta,
    } as any,
    logger,
    request,
    shellResponse,
    viewerShell,
    performScrape,
  ).then(
    () => null,
    (error: unknown) => error,
  );
  return { outcome, calls };
}

const tempFiles: string[] = [];
afterEach(async () => {
  await Promise.all(
    tempFiles.splice(0).map(file => unlink(file).catch(() => undefined)),
  );
});

describe("resolvePdfJsViewerShell", () => {
  it("hands the PDF off when the document the page names serves one", async () => {
    const { outcome, calls } = await resolve(
      shell({ url: DOCUMENT_URL, source: "script" }),
      [
        async () => {
          throw handoff(DOCUMENT_URL);
        },
      ],
    );

    expect(outcome).toBeInstanceOf(AddFeatureError);
    expect((outcome as AddFeatureError).featureFlags).toEqual(["pdf"]);
    expect((outcome as AddFeatureError).pdfPrefetch?.url).toBe(DOCUMENT_URL);
    // One navigation, to the document, with the shell's own request options
    // and without the actions that targeted the viewer page.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(DOCUMENT_URL);
    expect(calls[0].actions).toBeUndefined();
    expect(calls[0].headers).toEqual({ "x-test": "1" });
    // …and with the remaining scrape budget, not the original timeout.
    expect(calls[0].timeout).toBe(12345);
  });

  it("reports the document URL's status when neither route yields a PDF", async () => {
    const { outcome, calls } = await resolve(
      shell({ url: DOCUMENT_URL, source: "query" }),
      [
        async () => page(DOCUMENT_URL, 401, "<html>Unauthorized</html>"),
        async () =>
          probe({
            ok: false,
            reason: "load_failed",
            message: `Unexpected server response (401) while retrieving PDF "${DOCUMENT_URL}".`,
            url: DOCUMENT_URL,
          }),
      ],
    );

    expect(outcome).toBeInstanceOf(PDFViewerUnresolvedError);
    const error = outcome as PDFViewerUnresolvedError;
    expect(error.code).toBe("SCRAPE_PDF_VIEWER_UNRESOLVED");
    expect(error.reason).toBe("document_fetch_failed");
    expect(error.statusCode).toBe(401);
    expect(error.documentUrl).toBe(DOCUMENT_URL);
    expect(error.viewerUrl).toBe(VIEWER_URL);
    expect(error.message).toContain("PDF.js viewer");
    expect(error.message).toContain("HTTP 401");

    // The second navigation reloads the viewer with stylesheets enabled and
    // the extraction probe attached, off the render fleet.
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe(VIEWER_URL);
    expect(calls[1].blockMedia).toBe(false);
    expect(calls[1].forceNonRender).toBe(true);
    expect(calls[1].actions).toHaveLength(1);
    const action = calls[1].actions![0] as any;
    expect(action.type).toBe("executeJavascript");
    expect(action.script).toContain("PDFViewerApplication");
    expect(action.metadata).toEqual({ __firecrawl_internal: true });
  });

  it("extracts the document from the viewer when the page does not name it", async () => {
    const { outcome, calls } = await resolve(shell(null), [
      async () =>
        probe(
          {
            ok: true,
            base64: PDF.toString("base64"),
            size: PDF.length,
            url: "content?entityRef=abc",
          },
          { usedMobileProxy: true },
        ),
    ]);

    expect(outcome).toBeInstanceOf(AddFeatureError);
    const prefetch = (outcome as AddFeatureError).pdfPrefetch!;
    tempFiles.push(prefetch.filePath);
    expect(await readFile(prefetch.filePath)).toEqual(PDF);
    expect(prefetch.url).toBe(
      "https://archive.example.org/render/content?entityRef=abc",
    );
    expect(prefetch.status).toBe(200);
    expect(prefetch.proxyUsed).toBe("stealth");
    expect(prefetch.contentType).toBe("application/pdf");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(VIEWER_URL);
  });

  it("fetches an oversized document through the browser instead", async () => {
    const { outcome, calls } = await resolve(shell(null), [
      async () =>
        probe({
          ok: false,
          reason: "too_large",
          size: 30 * 1024 * 1024,
          url: "/files/big.pdf",
        }),
      async () => {
        throw handoff("https://archive.example.org/files/big.pdf");
      },
    ]);

    expect(outcome).toBeInstanceOf(AddFeatureError);
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe("https://archive.example.org/files/big.pdf");
    expect(calls[1].actions).toBeUndefined();
  });

  it("fails when the viewer never loads a document", async () => {
    const { outcome } = await resolve(shell(null), [
      async () => probe({ ok: false, reason: "no_document", url: null }),
    ]);

    expect(outcome).toBeInstanceOf(PDFViewerUnresolvedError);
    expect((outcome as PDFViewerUnresolvedError).reason).toBe(
      "document_not_located",
    );
  });

  it("fails when the page has no PDFViewerApplication", async () => {
    const { outcome } = await resolve(shell(null), [
      async () => probe({ ok: false, reason: "no_viewer_application" }),
    ]);

    expect(outcome).toBeInstanceOf(PDFViewerUnresolvedError);
    expect((outcome as PDFViewerUnresolvedError).reason).toBe(
      "document_not_located",
    );
  });

  it("rejects extracted bytes that are not a PDF", async () => {
    const html = Buffer.from("<html><body>not a pdf</body></html>");
    const { outcome } = await resolve(shell(null), [
      async () =>
        probe({ ok: true, base64: html.toString("base64"), size: html.length }),
    ]);

    expect(outcome).toBeInstanceOf(PDFViewerUnresolvedError);
    expect((outcome as PDFViewerUnresolvedError).reason).toBe(
      "viewer_load_failed",
    );
  });

  it("escalates to the stealth proxy when the document is blocked", async () => {
    const blocked: Scrape = async () =>
      probe({
        ok: false,
        reason: "load_failed",
        message: "Unexpected server response (403) while retrieving PDF",
        url: "doc.pdf",
      });

    const auto = await resolve(shell(null), [blocked]);
    expect(auto.outcome).toBeInstanceOf(AddFeatureError);
    expect((auto.outcome as AddFeatureError).featureFlags).toEqual([
      "stealthProxy",
    ]);

    // Already on stealth: nothing left to escalate to.
    const stealth = await resolve(shell(null), [blocked], {
      featureFlags: new Set(["stealthProxy"]),
    });
    expect(stealth.outcome).toBeInstanceOf(PDFViewerUnresolvedError);
    expect((stealth.outcome as PDFViewerUnresolvedError).statusCode).toBe(403);
    expect((stealth.outcome as PDFViewerUnresolvedError).reason).toBe(
      "viewer_load_failed",
    );
  });

  it("does not escalate an expired token", async () => {
    const { outcome } = await resolve(shell(null), [
      async () =>
        probe({
          ok: false,
          reason: "load_failed",
          message: "Unexpected server response (401) while retrieving PDF",
          url: "doc.pdf",
        }),
    ]);

    expect(outcome).toBeInstanceOf(PDFViewerUnresolvedError);
    expect((outcome as PDFViewerUnresolvedError).statusCode).toBe(401);
  });

  it("lets an abort through untouched", async () => {
    const abort = new AbortManagerThrownError("scrape", new Error("timeout"));
    const { outcome, calls } = await resolve(
      shell({ url: DOCUMENT_URL, source: "embed" }),
      [
        async () => {
          throw abort;
        },
      ],
    );

    expect(outcome).toBe(abort);
    expect(calls).toHaveLength(1);
  });

  it("drops caller headers when the named document lives on another origin", async () => {
    const elsewhere = "https://cdn.other.example/files/doc.pdf";
    const { outcome, calls } = await resolve(
      shell({ url: elsewhere, source: "embed" }),
      [
        async () => {
          throw handoff(elsewhere);
        },
      ],
    );

    expect(outcome).toBeInstanceOf(AddFeatureError);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(elsewhere);
    expect(calls[0].headers).toBeUndefined();
  });

  it.each([
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.7/report.pdf",
    "http://10.0.0.7./report.pdf",
    "http://[::1]:8080/report.pdf",
    "http://localhost/report.pdf",
    "http://localhost./report.pdf",
    "http://intranet/report.pdf",
    "https://files.corp.internal/report.pdf",
    "https://files.corp.internal./report.pdf",
  ])("refuses to fetch a document from a non-public host: %s", async url => {
    const { outcome, calls } = await resolve(shell({ url, source: "script" }), [
      async () => probe({ ok: false, reason: "no_document", url: null }),
    ]);

    // Never navigated there: the only navigation is the viewer probe.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(VIEWER_URL);
    expect(outcome).toBeInstanceOf(PDFViewerUnresolvedError);
    expect((outcome as PDFViewerUnresolvedError).detail).toContain("refused");
  });

  it("probes the viewer when the named document's handoff came back empty", async () => {
    const { outcome, calls } = await resolve(
      shell({ url: DOCUMENT_URL, source: "script" }),
      [
        // specialtyScrapeCheck saw a PDF response but fire-engine captured
        // no file: a "pdf" handoff with a null prefetch.
        async () => {
          throw new AddFeatureError(["pdf"], null);
        },
        async () =>
          probe({ ok: true, base64: PDF.toString("base64"), size: PDF.length }),
      ],
    );

    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe(VIEWER_URL);
    expect(outcome).toBeInstanceOf(AddFeatureError);
    const prefetch = (outcome as AddFeatureError).pdfPrefetch!;
    tempFiles.push(prefetch.filePath);
    expect(await readFile(prefetch.filePath)).toEqual(PDF);
  });

  it("does not let a non-PDF 200 page hide a blocked document", async () => {
    const { outcome } = await resolve(
      shell({ url: DOCUMENT_URL, source: "query" }),
      [
        async () => page(DOCUMENT_URL, 200, "<html>Please sign in</html>"),
        async () =>
          probe({
            ok: false,
            reason: "load_failed",
            message: "Unexpected server response (403) while retrieving PDF",
            url: DOCUMENT_URL,
          }),
      ],
    );

    // The 403 the viewer saw drives the outcome: stealth gets its round trip.
    expect(outcome).toBeInstanceOf(AddFeatureError);
    expect((outcome as AddFeatureError).featureFlags).toEqual(["stealthProxy"]);
  });

  it("carries the shell's screenshot into the handoff", async () => {
    const screenshot = "data:image/png;base64,c2hvdA==";
    const meta = {
      options: {
        proxy: "auto",
        formats: [
          { type: "screenshot", fullPage: false },
          { type: "markdown" },
        ],
      },
    };
    const shellWithScreenshot = {
      ...page(VIEWER_URL),
      screenshots: [screenshot],
    };

    // Extracted in page.
    const extracted = await resolve(
      shell(null),
      [
        async () =>
          probe({ ok: true, base64: PDF.toString("base64"), size: PDF.length }),
      ],
      meta,
      shellWithScreenshot,
    );
    const prefetch = (extracted.outcome as AddFeatureError).pdfPrefetch!;
    tempFiles.push(prefetch.filePath);
    expect(prefetch.screenshot).toBe(screenshot);

    // Downloaded through the browser.
    const downloaded = await resolve(
      shell({ url: DOCUMENT_URL, source: "query" }),
      [
        async () => {
          throw handoff(DOCUMENT_URL);
        },
      ],
      meta,
      shellWithScreenshot,
    );
    expect(
      (downloaded.outcome as AddFeatureError).pdfPrefetch?.screenshot,
    ).toBe(screenshot);
  });

  it("reports a viewer that could not be loaded again", async () => {
    const { outcome } = await resolve(shell(null), [
      async () => {
        throw new Error("Scrape job failed");
      },
    ]);

    expect(outcome).toBeInstanceOf(PDFViewerUnresolvedError);
    const error = outcome as PDFViewerUnresolvedError;
    expect(error.reason).toBe("viewer_unavailable");
    expect(error.detail).toBe("Scrape job failed");
  });
});
