import { Meta } from "..";
import { Document } from "../../../controllers/v2/types";
import { config } from "../../../config";
import { hasFormatOfType } from "../../../lib/format-utils";

export async function fetchMenu(
  meta: Meta,
  document: Document,
): Promise<Document> {
  if (!hasFormatOfType(meta.options.formats, "menu")) {
    return document;
  }

  // Beta gate: during beta the menu format is limited to teams with the menuBeta
  // flag. Fail closed and silent (mirrors highlightsBeta) -- a team without the
  // flag gets no menu field, no error, and no engine call.
  if (meta.internalOptions?.teamFlags?.menuBeta !== true) {
    meta.logger.info("menu format requested without menuBeta flag; skipping");
    return document;
  }

  if (!config.MENU_EXTRACTION_SERVICE_URL) {
    meta.logger.warn("MENU_EXTRACTION_SERVICE_URL is not configured");
    document.warning =
      "Menu format is not available (service not configured)." +
      (document.warning ? " " + document.warning : "");
    return document;
  }

  if (document.rawHtml === undefined) {
    throw new Error(
      "rawHtml is undefined -- fetchMenu must run after rawHtml is available",
    );
  }

  const url =
    document.metadata.url ??
    document.metadata.sourceURL ??
    meta.rewrittenUrl ??
    meta.url;

  const response = await fetch(
    `${config.MENU_EXTRACTION_SERVICE_URL}/v1/scrape-menu`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        html: document.rawHtml,
        url,
        title: document.metadata.title ?? undefined,
      }),
    },
  );

  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ detail: "Unknown error" }));
    throw new Error(`Menu extraction failed: ${error.detail}`);
  }

  let data: any;
  try {
    data = await response.json();
  } catch {
    throw new Error(
      "Menu extraction failed: service returned a non-JSON response",
    );
  }

  // The service contract is a 200 with a body of `{ menu: Menu | null }`.
  // A body that isn't an object, or is missing the `menu` key entirely, is a
  // malformed response -- surface it as a service failure rather than silently
  // reporting "no menu found" (which is reserved for an explicit `null`).
  if (typeof data !== "object" || data === null || !("menu" in data)) {
    throw new Error(
      "Menu extraction failed: service returned an unexpected response shape (missing 'menu')",
    );
  }

  if (data.menu) {
    document.menu = data.menu;
  } else {
    // `menu` is null: the page loaded but is not a menu page.
    document.warning =
      "No menu found on this page; it does not appear to be a menu page." +
      (document.warning ? " " + document.warning : "");
  }
  return document;
}
