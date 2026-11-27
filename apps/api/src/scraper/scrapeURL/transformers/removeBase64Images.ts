import type { Meta } from "..";
import type { Document } from "../../../controllers/v2/types";

const regex = /(!\[.*?\])\(data:image\/.*?;base64,.*?\)/g;

export function removeBase64Images(meta: Meta, document: Document): Document {
  if (meta.options.removeBase64Images && document.markdown !== undefined) {
    document.markdown = document.markdown.replaceAll(
      regex,
      "$1(<Base64-Image-Removed>)",
    );
  }
  return document;
}
