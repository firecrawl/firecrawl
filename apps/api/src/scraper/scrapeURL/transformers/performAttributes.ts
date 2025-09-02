import { Document } from "../../../controllers/v2/types";
import { Meta } from "..";
import { extractAttributes } from "../lib/extractAttributes";
import { hasFormatOfType } from "../../../lib/format-utils";

/**
 * Transformer to extract attributes from HTML using the attributes format
 */
export async function performAttributes(
  meta: Meta,
  document: Document,
): Promise<Document> {
  const attributesFormat = hasFormatOfType(meta.options.formats, "attributes");

  if (!attributesFormat) {
    return document;
  }

  if (document.html === undefined) {
    throw new Error(
      "html is undefined -- this transformer is being called out of order",
    );
  }

  if (attributesFormat.selectors && attributesFormat.selectors.length > 0) {
    try {
      const attributes = await extractAttributes(
        document.html,
        attributesFormat.selectors,
      );

      if (attributes.length > 0) {
        document.attributes = attributes;

        meta.logger.debug("Extracted attributes", {
          count: attributes.length,
          attributes: attributes.map(d => ({
            selector: d.selector,
            attribute: d.attribute,
            valuesCount: d.values.length,
          })),
        });
      }
    } catch (error) {
      meta.logger.error("Failed to extract attributes", {
        error,
        url: meta.url,
      });
    }
  }

  return document;
}
