import type { Meta } from "..";
import type { Document } from "../../../controllers/v2/types";

const regex =
  /(!\[.*?\])\(data:image\/[^)\r\n\u2028\u2029]*?;base64,[^)\r\n\u2028\u2029]*?\)/g;

export function removeBase64Images(meta: Meta, document: Document): Document {
  if (meta.options.removeBase64Images && document.markdown !== undefined) {
    document.markdown = document.markdown.replaceAll(
      regex,
      "$1(<Base64-Image-Removed>)",
    );
  }
  return document;
}
