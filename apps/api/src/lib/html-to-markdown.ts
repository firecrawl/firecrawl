import koffi from "koffi";
import { config } from "../config";
import "../services/sentry";
import * as Sentry from "@sentry/node";
import { logger } from "./logger";
import type { Logger } from "winston";
import { stat } from "fs/promises";
import { HTML_TO_MARKDOWN_PATH } from "../natives";
import { convertHTMLToMarkdownWithHttpService } from "./html-to-markdown-client";
import { postProcessMarkdown } from "@mendable/firecrawl-rs";
import { MarkdownConversionError } from "./error";

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
  },
): Promise<string> {
  if (!html) {
    return "";
  }

  const contextLogger = context?.logger || logger;
  const requestId = context?.requestId;

  // Try HTTP service first if enabled
  if (config.HTML_TO_MARKDOWN_SERVICE_URL) {
    try {
      let markdownContent = await convertHTMLToMarkdownWithHttpService(html, {
        logger: contextLogger,
        requestId,
      });
      markdownContent = await postProcessMarkdown(markdownContent);
      return markdownContent;
    } catch (error) {
      contextLogger.error("Error converting HTML to Markdown with HTTP service", {
        error,
      });
      Sentry.captureException(error, {
        tags: {
          ...(requestId ? { request_id: requestId } : {}),
        },
      });
      throw new MarkdownConversionError(
        "HTML-to-Markdown service failed. Verify HTML_TO_MARKDOWN_SERVICE_URL is reachable.",
      );
    }
  }

  if (!config.USE_GO_MARKDOWN_PARSER) {
    throw new MarkdownConversionError(
      "No HTML-to-Markdown parser configured. Enable the Go parser or set HTML_TO_MARKDOWN_SERVICE_URL.",
    );
  }

  try {
    const converter = await GoMarkdownConverter.getInstance();
    let markdownContent = await converter.convertHTMLToMarkdown(html);
    markdownContent = await postProcessMarkdown(markdownContent);
    return markdownContent;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown Go parser error";
    if (message !== "Go shared library not found") {
      Sentry.captureException(error, {
        tags: {
          ...(requestId ? { request_id: requestId } : {}),
        },
      });
      contextLogger.error("Error converting HTML to Markdown with Go parser", {
        error,
      });
    } else {
      contextLogger.error("Go HTML-to-Markdown parser not found", {
        HTML_TO_MARKDOWN_PATH,
      });
    }
    throw new MarkdownConversionError(
      message === "Go shared library not found"
        ? "Go HTML-to-Markdown parser not found on disk."
        : "Go HTML-to-Markdown parser failed.",
    );
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
