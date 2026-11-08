import type { Format } from "./types.js";
import { htmlFormat } from "./html.js";
import { jsonFormat } from "./json.js";
import { markdownFormat } from "./markdown.js";
import { screenshotFormat } from "./screenshot.js";

export const formats: Record<string, Format> = {
  [markdownFormat.name]: markdownFormat,
  [htmlFormat.name]: htmlFormat,
  [jsonFormat.name]: jsonFormat,
  [screenshotFormat.name]: screenshotFormat,
};

export function getFormat(name: string): Format {
  const f = formats[name];
  if (!f) {
    throw new Error(`Unknown format "${name}". Available: ${Object.keys(formats).join(", ")}`);
  }
  return f;
}
