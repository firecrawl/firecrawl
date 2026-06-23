import type { Meta } from "../context";
import type { Document } from "../../../controllers/v2/types";
import { extractLinks } from "../lib/html/extract-links";
import { hasFormatOfType } from "../../../lib/format-utils";

export async function deriveLinksFromHTML(
  meta: Meta,
  document: Document,
): Promise<Document> {
  if (!hasFormatOfType(meta.options.formats, "links")) return document;

  if (document.html === undefined) {
    throw new Error(
      "html is undefined -- this transformer is being called out of order",
    );
  }

  document.links = await extractLinks(
    document.html,
    document.metadata.url ?? document.metadata.sourceURL ?? meta.url,
  );
  return document;
}
