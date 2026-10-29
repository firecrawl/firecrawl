import { JSDOM } from "jsdom";

export function parseDocument(html: string): Document {
  return new JSDOM(html).window.document;
}

export const ELEMENT_NODE = 1;
export const TEXT_NODE = 3;
export const COMMENT_NODE = 8;
