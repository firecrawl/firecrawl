import { load } from "cheerio";
import { logger } from "../../../lib/logger";
import { extractAttributesRust } from "../../../lib/html-transformer";

export type AttributeResult = {
  selector: string;
  attribute: string;
  values: string[];
};

export type AttributeSelector = {
  selector: string;
  attribute: string;
};

/**
 * Extracts attributes from HTML using Rust html-transformer (with Cheerio fallback)
 * @param html - The HTML content to extract from
 * @param selectors - Array of selector/attribute pairs to extract
 * @returns Array of extracted attribute results
 */
export async function extractAttributes(
  html: string,
  selectors: AttributeSelector[]
): Promise<AttributeResult[]> {
  if (!selectors || selectors.length === 0) {
    return [];
  }

  // Try Rust implementation first (faster, non-blocking)
  try {
    const results = await extractAttributesRust(html, selectors);

    logger.debug("Attribute extraction via Rust", {
      selectorsCount: selectors.length,
      resultsCount: results.length,
      sampleResults: results.slice(0, 2).map(r => ({
        selector: r.selector,
        attribute: r.attribute,
        valuesCount: r.values.length
      }))
    });

    return results;
  } catch (error) {
    logger.warn("Failed to extract attributes with Rust, falling back to Cheerio", {
      error,
      module: "scrapeURL",
      method: "extractAttributes"
    });
  }

  // Fallback to Cheerio implementation
  const results: AttributeResult[] = [];

  try {
    const $ = load(html);

    for (const extraction of selectors) {
      const { selector, attribute } = extraction;
      const values: string[] = [];

      // Find all elements matching the selector
      $(selector).each((_, element) => {
        // Get the attribute value
        // Support both data-* format and without data- prefix
        let attrValue = $(element).attr(attribute);

        // If not found and attribute doesn't start with 'data-', try with 'data-' prefix
        if (!attrValue && !attribute.startsWith('data-')) {
          attrValue = $(element).attr(`data-${attribute}`);
        }

        if (attrValue) {
          values.push(attrValue);
        }
      });

      results.push({
        selector,
        attribute,
        values
      });

      logger.debug("Attribute extraction via Cheerio fallback", {
        selector,
        attribute,
        valuesCount: values.length,
        sample: values.slice(0, 3)
      });
    }
  } catch (error) {
    logger.error("Failed to extract attributes with Cheerio fallback", {
      error,
      module: "scrapeURL",
      method: "extractAttributes"
    });
  }

  return results;
}
