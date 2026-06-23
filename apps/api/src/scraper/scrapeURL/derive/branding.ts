import type { Meta } from "../context";
import type { Document } from "../../../controllers/v2/types";
import { hasFormatOfType } from "../../../lib/format-utils";
import { brandingTransformer } from "../../../lib/branding/transformer";

export async function deriveBrandingFromActions(
  meta: Meta,
  document: Document,
): Promise<Document> {
  if (!hasFormatOfType(meta.options.formats, "branding")) return document;
  if (document.branding !== undefined) return document;

  const brandingReturnIndex = document.actions?.javascriptReturns?.findIndex(
    x =>
      x.type === "object" &&
      x.value !== null &&
      typeof x.value === "object" &&
      "branding" in x.value &&
      (x.value as any).branding !== null &&
      typeof (x.value as any).branding === "object",
  );

  if (brandingReturnIndex === -1 || brandingReturnIndex === undefined) {
    return document;
  }

  const javascriptReturn = document.actions!.javascriptReturns![
    brandingReturnIndex
  ].value as any;
  const rawBranding = javascriptReturn.branding;

  document.actions!.javascriptReturns!.splice(brandingReturnIndex, 1);
  document.branding = await brandingTransformer(meta, document, rawBranding);
  return document;
}
