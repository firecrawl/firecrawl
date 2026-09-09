import type { FormatObject } from "../../../controllers/v2/types";
import type { EngineScrapeResult } from "../engines";
import {
  detectPdfJsViewerShell,
  type PdfJsViewerShell,
} from "./pdfjsViewerShell";

/**
 * A page whose HTML is a viewer or loader "shell" around the real content
 * rather than the content itself. Such pages pass the plain success factors
 * (a 200 with some text) while carrying nothing the caller asked for.
 *
 * Every engine result is checked here before the success decision: an engine
 * that can resolve a shell does so itself and never returns one (chrome-cdp
 * resolves pdf.js viewers, see fire-engine/pdfjsViewer.ts); any other
 * engine's shell result is declined so the waterfall moves on. Further shell
 * kinds (Google Docs viewer, ViewerJS, Scribd embeds, …) join this union.
 */
export type ContentShell = PdfJsViewerShell;

/**
 * Whether an engine result's body is HTML as far as shell detection cares.
 * A missing content type is assumed to be HTML: engines only omit it for
 * rendered pages, never for the files they hand off.
 */
function isHtmlLikeContentType(contentType: string | undefined): boolean {
  if (!contentType) return true;
  const mediaType = contentType.split(";")[0].trim().toLowerCase();
  return (
    mediaType === "" ||
    mediaType === "text/html" ||
    mediaType === "application/xhtml+xml"
  );
}

/**
 * Whether a request is after the page's content at all. A screenshot-only or
 * branding-only request wants the rendered viewer as it is; redirecting it
 * to the document would drop the very output it asked for. Everything else
 * (markdown and its derivatives, html, links, json, …) wants the document.
 */
export function wantsPageContent(formats: FormatObject[] | undefined): boolean {
  if (!formats || formats.length === 0) return true;
  return formats.some(f => f.type !== "screenshot" && f.type !== "branding");
}

export function detectContentShell(
  result: Pick<EngineScrapeResult, "html" | "url" | "contentType">,
): ContentShell | null {
  if (!result.html || !isHtmlLikeContentType(result.contentType)) return null;
  return detectPdfJsViewerShell(result.html, result.url);
}
