import koffi from "koffi";
import { join } from "path";
import "../services/sentry";
import * as Sentry from "@sentry/node";

import dotenv from "dotenv";
import { logger } from "./logger";
import { stat } from "fs/promises";
dotenv.config();

// N-API module path (preferred)
const napiModulePath = join(
  process.cwd(),
  "sharedLibs",
  "go-html-to-md-napi",
  "build",
  "Release",
  "html_to_markdown.node"
);

// Koffi module path (fallback)
const koffiExecutablePath = join(
  process.cwd(),
  "sharedLibs",
  "go-html-to-md",
  "html-to-markdown.so",
);

class GoMarkdownConverter {
  private static instance: GoMarkdownConverter;
  private napiModule: any = null;
  private koffiModule: any = null;
  private moduleLoadAttempted = false;
  
  private async loadModules() {
    if (this.moduleLoadAttempted) {
      return;
    }
    
    this.moduleLoadAttempted = true;
    
    // Try to load N-API module first
    try {
      await stat(napiModulePath);
      this.napiModule = require(napiModulePath);
      logger.info("Successfully loaded N-API HTML-to-Markdown module");
      return; // Success, don't load koffi
    } catch (error) {
      logger.warn("N-API module not available, falling back to koffi", { 
        error: error instanceof Error ? error.message : String(error),
        path: napiModulePath 
      });
    }

    // Fallback to koffi if N-API fails
    try {
      await stat(koffiExecutablePath);
      const lib = koffi.load(koffiExecutablePath);
      const free = lib.func("FreeCString", "void", ["string"]);
      const cstn = "CString:" + crypto.randomUUID();
      const freedResultString = koffi.disposable(cstn, "string", free);
      const convert = lib.func("ConvertHTMLToMarkdown", freedResultString, ["string"]);
      
      this.koffiModule = { convert, free };
      logger.info("Successfully loaded koffi HTML-to-Markdown module");
    } catch (error) {
      logger.error("Failed to load both N-API and koffi modules", { error });
      throw new Error("No HTML-to-Markdown module available");
    }
  }

  public static async getInstance(): Promise<GoMarkdownConverter> {
    if (!GoMarkdownConverter.instance) {
      GoMarkdownConverter.instance = new GoMarkdownConverter();
      await GoMarkdownConverter.instance.loadModules();
    }
    return GoMarkdownConverter.instance;
  }

  public async convertHTMLToMarkdown(html: string): Promise<string> {
    // Try N-API first (synchronous, stable)
    if (this.napiModule && this.napiModule.convertSync) {
      try {
        return this.napiModule.convertSync(html);
      } catch (error) {
        logger.error("N-API conversion failed, trying koffi fallback", { error });
        Sentry.captureException(error);
      }
    }
    
    // Fallback to koffi (asynchronous)
    if (this.koffiModule) {
      return new Promise<string>((resolve, reject) => {
        this.koffiModule.convert.async(html, (err: Error, res: string) => {
          if (err) {
            reject(err);
          } else {
            resolve(res);
          }
        });
      });
    }
    
    throw new Error("No HTML-to-Markdown module available");
  }
}

export async function parseMarkdown(
  html: string | null | undefined,
): Promise<string> {
  if (!html) {
    return "";
  }

  try {
    if (process.env.USE_GO_MARKDOWN_PARSER == "true") {
      const converter = await GoMarkdownConverter.getInstance();
      let markdownContent = await converter.convertHTMLToMarkdown(html);

      markdownContent = processMultiLineLinks(markdownContent);
      markdownContent = removeSkipToContentLinks(markdownContent);
      // logger.info(`HTML to Markdown conversion using Go parser successful`);
      return markdownContent;
    }
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.message !== "Go shared library not found"
    ) {
      Sentry.captureException(error);
      logger.error(
        `Error converting HTML to Markdown with Go parser: ${error}`,
      );
    } else {
      logger.warn(
        "Tried to use Go parser, but it doesn't exist in the file system.",
        { koffiExecutablePath, napiModulePath },
      );
    }
  }

  // Fallback to TurndownService if Go parser fails or is not enabled
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
    markdownContent = processMultiLineLinks(markdownContent);
    markdownContent = removeSkipToContentLinks(markdownContent);

    return markdownContent;
  } catch (error) {
    logger.error("Error converting HTML to Markdown", { error });
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