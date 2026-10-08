import { Meta } from "..";
import { Document } from "../../../controllers/v1/types";

const regex =
  /(!\[.*?\])\(data:image\/[^)\r\n\u2028\u2029]*?;base64,[^)\r\n\u2028\u2029]*?\)/g;

export function removeBase64Images(meta: Meta, document: Document): Document {
  if (meta.options.removeBase64Images && document.markdown !== undefined) {
    document.markdown = document.markdown.replace(
      regex,
      "$1(<Base64-Image-Removed>)",
    );
  }
  return document;
}
