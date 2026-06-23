import type { Meta } from "../context";
import type { Document } from "../../../controllers/v2/types";
import { htmlTransform } from "../lib/html/remove-unwanted-elements";

export async function deriveHTMLFromRawHTML(
  meta: Meta,
  document: Document,
): Promise<Document> {
  if (document.rawHtml === undefined) {
    throw new Error(
      "rawHtml is undefined -- this transformer is being called out of order",
    );
  }

  document.html = await htmlTransform(
    document.rawHtml,
    document.metadata.url ?? document.metadata.sourceURL ?? meta.url,
    meta.options,
  );
  return document;
}
