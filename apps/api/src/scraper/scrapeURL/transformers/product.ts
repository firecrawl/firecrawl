import { Meta } from "..";
import { Document } from "../../../controllers/v2/types";
import { config } from "../../../config";
import { hasFormatOfType } from "../../../lib/format-utils";

export async function fetchProduct(
  meta: Meta,
  document: Document,
): Promise<Document> {
  if (!hasFormatOfType(meta.options.formats, "product")) {
    return document;
  }

  if (!config.PRODUCT_EXTRACTION_SERVICE_URL) {
    meta.logger.warn("PRODUCT_EXTRACTION_SERVICE_URL is not configured");
    document.warning =
      "Product format is not available (service not configured)." +
      (document.warning ? " " + document.warning : "");
    return document;
  }

  if (document.rawHtml === undefined) {
    throw new Error(
      "rawHtml is undefined -- fetchProduct must run after rawHtml is available",
    );
  }

  const url =
    document.metadata.url ??
    document.metadata.sourceURL ??
    meta.rewrittenUrl ??
    meta.url;

  const response = await fetch(
    `${config.PRODUCT_EXTRACTION_SERVICE_URL}/v1/extract-product`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ html: document.rawHtml, url }),
    },
  );

  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ detail: "Unknown error" }));
    throw new Error(`Product extraction failed: ${error.detail}`);
  }

  let data: any;
  try {
    data = await response.json();
  } catch {
    throw new Error(
      "Product extraction failed: service returned a non-JSON response",
    );
  }

  // The service contract is a 200 with a body of `{ product: Product | null }`.
  // A body that isn't an object, or is missing the `product` key entirely, is a
  // malformed response -- surface it as a service failure rather than silently
  // reporting "no product found" (which is reserved for an explicit `null`).
  if (typeof data !== "object" || data === null || !("product" in data)) {
    throw new Error(
      "Product extraction failed: service returned an unexpected response shape (missing 'product')",
    );
  }

  if (data.product) {
    document.product = data.product;
  } else {
    // `product` is null: the page loaded but is not a product page.
    document.warning =
      "No product found on this page; it does not appear to be a product page." +
      (document.warning ? " " + document.warning : "");
  }
  return document;
}
