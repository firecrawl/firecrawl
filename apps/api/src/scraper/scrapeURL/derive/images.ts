import type { Meta } from "../context";
import type { Document } from "../../../controllers/v2/types";
import { extractImages } from "../lib/html/extract-images";
import { hasFormatOfType } from "../../../lib/format-utils";

export async function deriveImagesFromHTML(
  meta: Meta,
  document: Document,
): Promise<Document> {
  if (!hasFormatOfType(meta.options.formats, "images")) return document;

  if (document.html === undefined) {
    throw new Error(
      "html is undefined -- this transformer is being called out of order",
    );
  }

  document.images = await extractImages(
    document.html,
    document.metadata.url ?? document.metadata.sourceURL ?? meta.url,
  );
  return document;
}
