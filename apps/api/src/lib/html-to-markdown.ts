import koffi from "koffi";
import { config } from "../config";
import { logger } from "./logger";
import type { Logger } from "winston";
import { stat } from "fs/promises";
import { HTML_TO_MARKDOWN_PATH } from "../natives";
import { convertHTMLToMarkdownWithHttpService } from "./html-to-markdown-client";
import {
  convertHtmlToMarkdown,
  postProcessMarkdown,
} from "@mendable/firecrawl-rs";
export { getInnerJson } from "@mendable/firecrawl-rs";

type BaselineMarkdownEngine = "go-http" | "go-koffi" | "turndown";

const MAX_CONCURRENT_SHADOW_JOBS = 4;
let activeShadowJobs = 0;

function extractMarkdownLinkUrls(markdown: string): Set<string> {
  const urls = new Set<string>();
  const stack: Array<{ isImage: boolean }> = [];

  for (let i = 0; i < markdown.length; i++) {
    const ch = markdown[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "[") {
      const isImage =
        i > 0 && markdown[i - 1] === "!" && (i < 2 || markdown[i - 2] !== "\\");
      stack.push({ isImage });
      continue;
    }
    if (ch === "]" && stack.length > 0) {
      const opener = stack.pop()!;
      if (markdown[i + 1] !== "(") {
        continue;
      }
      let j = i + 2;
      while (j < markdown.length && /\s/.test(markdown[j])) {
        j++;
      }
      let dest = "";
      if (markdown[j] === "<") {
        const end = markdown.indexOf(">", j + 1);
        if (end !== -1) {
          dest = markdown.slice(j + 1, end).trim();
          const closeParen = markdown.indexOf(")", end + 1);
          if (closeParen !== -1) {
            i = closeParen;
          }
        }
      } else {
        let depth = 0;
        let k = j;
        while (k < markdown.length) {
          const c = markdown[k];
          if (c === "\\") {
            k += 2;
            continue;
          }
          if (c === "(") {
            depth++;
          } else if (c === ")") {
            if (depth === 0) {
              break;
            }
            depth--;
          } else if (/\s/.test(c) && depth === 0) {
            break;
          }
          k++;
        }
        dest = markdown.slice(j, k);
        let close = k;
        while (close < markdown.length && markdown[close] !== ")") {
          if (markdown[close] === "\\") {
            close += 2;
            continue;
          }
          close++;
        }
        if (close < markdown.length && markdown[close] === ")") {
          i = close;
        }
      }
      if (!opener.isImage && dest && !dest.toLowerCase().startsWith("data:")) {
        urls.add(dest);
      }
    }
  }

  return urls;
}

function extractNonDataImageUrls(markdown: string): Set<string> {
  const urls = new Set<string>();
  const regex = /!\[[^\]]*\]\(([^)\s]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdown)) !== null) {
    const src = match[1];
    if (src && !src.toLowerCase().startsWith("data:")) {
      urls.add(src);
    }
  }
  return urls;
}

function computeRecall(baseline: Set<string>, candidate: Set<string>): number {
  if (baseline.size === 0) {
    return 1;
  }
  let matched = 0;
  for (const item of baseline) {
    if (candidate.has(item)) {
      matched++;
    }
  }
  return matched / baseline.size;
}

function countCodeFences(markdown: string): number {
  let count = 0;
  for (const line of markdown.split("\n")) {
    if (/^\s*`{3,}/.test(line)) {
      count++;
    }
  }
  return Math.floor(count / 2);
}

function countTableRows(markdown: string): number {
  let count = 0;
  for (const line of markdown.split("\n")) {
    if (line.trimStart().startsWith("|")) {
      count++;
    }
  }
  return count;
}

function maybeRunRustShadow(params: {
  html: string;
  baselineMarkdown: string;
  baselineEngine: BaselineMarkdownEngine;
  baselineDurationMs: number;
  zeroDataRetention: boolean;
  requestId?: string;
  contextLogger: Logger;
}): void {
  const {
    html,
    baselineMarkdown,
    baselineEngine,
    baselineDurationMs,
    zeroDataRetention,
    requestId,
    contextLogger,
  } = params;

  if (
    zeroDataRetention ||
    config.RUST_HTML_TO_MD_SHADOW_RATE <= 0 ||
    activeShadowJobs >= MAX_CONCURRENT_SHADOW_JOBS ||
    Math.random() >= config.RUST_HTML_TO_MD_SHADOW_RATE
  ) {
    return;
  }

  activeShadowJobs++;
  const start = performance.now();
  void (async () => {
    try {
      const rustMarkdown = await convertHtmlToMarkdown(html);
      const rustDurationMs = Number((performance.now() - start).toFixed(2));
      const baselineLinks = extractMarkdownLinkUrls(baselineMarkdown);
      const rustLinks = extractMarkdownLinkUrls(rustMarkdown);
      const baselineImages = extractNonDataImageUrls(baselineMarkdown);
      const rustImages = extractNonDataImageUrls(rustMarkdown);
      const baselineBytes = Buffer.byteLength(baselineMarkdown, "utf8");
      const rustBytes = Buffer.byteLength(rustMarkdown, "utf8");

      contextLogger.info("Rust HTML-to-Markdown shadow comparison", {
        baseline_engine: baselineEngine,
        baseline_duration_ms: Number(baselineDurationMs.toFixed(2)),
        rust_duration_ms: rustDurationMs,
        input_bytes: Buffer.byteLength(html, "utf8"),
        baseline_bytes: baselineBytes,
        rust_bytes: rustBytes,
        byte_ratio:
          baselineBytes > 0
            ? Number((rustBytes / baselineBytes).toFixed(4))
            : rustBytes === 0
              ? 1
              : null,
        exact_match: baselineMarkdown === rustMarkdown,
        link_recall: Number(computeRecall(baselineLinks, rustLinks).toFixed(4)),
        baseline_link_count: baselineLinks.size,
        rust_link_count: rustLinks.size,
        image_recall: Number(
          computeRecall(baselineImages, rustImages).toFixed(4),
        ),
        baseline_image_count: baselineImages.size,
        rust_image_count: rustImages.size,
        code_fence_delta:
          countCodeFences(rustMarkdown) - countCodeFences(baselineMarkdown),
        table_row_delta:
          countTableRows(rustMarkdown) - countTableRows(baselineMarkdown),
        ...(requestId ? { request_id: requestId } : {}),
      });
    } catch (error) {
      contextLogger.warn("Rust HTML-to-Markdown shadow conversion failed", {
        error,
        baseline_engine: baselineEngine,
        input_bytes: Buffer.byteLength(html, "utf8"),
        ...(requestId ? { request_id: requestId } : {}),
      });
    } finally {
      activeShadowJobs--;
    }
  })();
}

// TODO: add a timeout to the Go parser

class GoMarkdownConverter {
  private static instance: GoMarkdownConverter;
  private convert: any;
  private free: any;

  private constructor() {
    const lib = koffi.load(HTML_TO_MARKDOWN_PATH);
    this.free = lib.func("FreeCString", "void", ["string"]);
    const cstn = "CString:" + crypto.randomUUID();
    const freedResultString = koffi.disposable(cstn, "string", this.free);
    this.convert = lib.func("ConvertHTMLToMarkdown", freedResultString, [
      "string",
    ]);
  }

  public static async getInstance(): Promise<GoMarkdownConverter> {
    if (!GoMarkdownConverter.instance) {
      try {
        await stat(HTML_TO_MARKDOWN_PATH);
      } catch (_) {
        throw Error("Go shared library not found");
      }
      GoMarkdownConverter.instance = new GoMarkdownConverter();
    }
    return GoMarkdownConverter.instance;
  }

  public async convertHTMLToMarkdown(html: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.convert.async(html, (err: Error, res: string) => {
        if (err) {
          reject(err);
        } else {
          resolve(res);
        }
      });
    });
  }
}

export async function parseMarkdown(
  html: string | null | undefined,
  context?: {
    logger?: Logger;
    requestId?: string;
    zeroDataRetention?: boolean;
  },
): Promise<string> {
  if (!html) {
    return "";
  }

  const contextLogger = context?.logger || logger;
  const requestId = context?.requestId;
  const zeroDataRetention = context?.zeroDataRetention === true;

  if (config.RUST_HTML_TO_MD_ENABLED) {
    try {
      return await convertHtmlToMarkdown(html);
    } catch (error) {
      contextLogger.error(
        "Error converting HTML to Markdown with Rust converter, falling back",
        { error },
      );
    }
  }

  // Try HTTP service first if enabled
  if (config.HTML_TO_MARKDOWN_SERVICE_URL) {
    const start = performance.now();
    try {
      let markdownContent = await convertHTMLToMarkdownWithHttpService(html, {
        logger: contextLogger,
        requestId,
        zeroDataRetention,
      });
      markdownContent = await postProcessMarkdown(markdownContent);
      maybeRunRustShadow({
        html,
        baselineMarkdown: markdownContent,
        baselineEngine: "go-http",
        baselineDurationMs: performance.now() - start,
        zeroDataRetention,
        requestId,
        contextLogger,
      });
      return markdownContent;
    } catch (error) {
      contextLogger.error(
        "Error converting HTML to Markdown with HTTP service, falling back to original parser",
        { error },
      );
    }
  }

  try {
    if (config.USE_GO_MARKDOWN_PARSER) {
      const start = performance.now();
      const converter = await GoMarkdownConverter.getInstance();
      let markdownContent = await converter.convertHTMLToMarkdown(html);
      markdownContent = await postProcessMarkdown(markdownContent);
      maybeRunRustShadow({
        html,
        baselineMarkdown: markdownContent,
        baselineEngine: "go-koffi",
        baselineDurationMs: performance.now() - start,
        zeroDataRetention,
        requestId,
        contextLogger,
      });
      return markdownContent;
    }
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.message !== "Go shared library not found"
    ) {
      contextLogger.error(
        `Error converting HTML to Markdown with Go parser: ${error}`,
      );
    } else {
      contextLogger.warn(
        "Tried to use Go parser, but it doesn't exist in the file system.",
        { HTML_TO_MARKDOWN_PATH },
      );
    }
  }

  // Fallback to TurndownService if Go parser fails or is not enabled
  const turndownStart = performance.now();
  var TurndownService = require("turndown");
  var turndownPluginGfm = require("joplin-turndown-plugin-gfm");

  const turndownService = new TurndownService();
  turndownService.addRule("inlineLink", {
    filter: function (node, options) {
      return (
        options.linkStyle === "inlined" &&
        node.nodeName === "A" &&
        node.getAttribute("href")
      );
    },
    replacement: function (content, node) {
      var href = node.getAttribute("href").trim();
      var title = node.title ? ' "' + node.title + '"' : "";
      return "[" + content.trim() + "](" + href + title + ")\n";
    },
  });
  var gfm = turndownPluginGfm.gfm;
  turndownService.use(gfm);

  try {
    let markdownContent = await turndownService.turndown(html);
    markdownContent = await postProcessMarkdown(markdownContent);
    maybeRunRustShadow({
      html,
      baselineMarkdown: markdownContent,
      baselineEngine: "turndown",
      baselineDurationMs: performance.now() - turndownStart,
      zeroDataRetention,
      requestId,
      contextLogger,
    });

    return markdownContent;
  } catch (error) {
    contextLogger.error("Error converting HTML to Markdown", { error });
    return ""; // Optionally return an empty string or handle the error as needed
  }
}

function processMultiLineLinks(markdownContent: string): string {
  let insideLinkContent = false;
  let newMarkdownContent = "";
  let linkOpenCount = 0;
  for (let i = 0; i < markdownContent.length; i++) {
    const char = markdownContent[i];

    if (char == "[") {
      linkOpenCount++;
    } else if (char == "]") {
      linkOpenCount = Math.max(0, linkOpenCount - 1);
    }
    insideLinkContent = linkOpenCount > 0;

    if (insideLinkContent && char == "\n") {
      newMarkdownContent += "\\" + "\n";
    } else {
      newMarkdownContent += char;
    }
  }
  return newMarkdownContent;
}

function removeSkipToContentLinks(markdownContent: string): string {
  // Remove [Skip to Content](#page) and [Skip to content](#skip)
  const newMarkdownContent = markdownContent.replace(
    /\[Skip to Content\]\(#[^\)]*\)/gi,
    "",
  );
  return newMarkdownContent;
}
