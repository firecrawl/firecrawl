import { readFile } from "node:fs/promises";
import escapeHtml from "escape-html";
import * as marked from "marked";
import { EngineScrapeResult } from "..";
import { Meta } from "../..";
import { UnsupportedFileError } from "../../error";

const fallbackContentTypes: Record<string, string> = {
  html: "text/html",
  markdown: "text/markdown",
  text: "text/plain",
};

export async function scrapeLocalFile(meta: Meta): Promise<EngineScrapeResult> {
  const localFile = meta.internalOptions.localFile;
  if (!localFile) {
    throw new UnsupportedFileError("Missing local file payload");
  }

  const contentType =
    localFile.contentType ||
    fallbackContentTypes[localFile.kind] ||
    "application/octet-stream";

  const raw = await readFile(localFile.path, "utf8");

  let html: string;
  switch (localFile.kind) {
    case "html":
      html = raw;
      break;
    case "markdown":
      html = await marked.parse(raw, { async: true });
      break;
    case "text":
      html = `<pre>${escapeHtml(raw)}</pre>`;
      break;
    default:
      throw new UnsupportedFileError(
        `Unsupported local file kind: ${localFile.kind}`,
      );
  }

  return {
    url: meta.rewrittenUrl ?? meta.url,
    statusCode: 200,
    html,
    contentType,
    proxyUsed: "basic",
  };
}

export function localFileMaxReasonableTime(): number {
  return 5000;
}
