import { join } from "path";
import "../services/sentry";
import * as Sentry from "@sentry/node";
import { logger } from "./logger";
import { stat } from "fs/promises";

// Import the N-API module
let napiModule: any = null;
let moduleLoadAttempted = false;

const napiModulePath = join(
  process.cwd(),
  "sharedLibs",
  "go-html-to-md-napi",
  "build",
  "Release",
  "html_to_markdown.node"
);

async function loadNAPIModule() {
  if (moduleLoadAttempted) {
    return napiModule;
  }
  
  moduleLoadAttempted = true;
  
  try {
    // Check if the module file exists
    await stat(napiModulePath);
    
    // Load the N-API module
    napiModule = require(napiModulePath);
    logger.info("Successfully loaded N-API HTML-to-Markdown module");
    return napiModule;
  } catch (error) {
    logger.warn("Failed to load N-API HTML-to-Markdown module", { 
      error: error.message,
      path: napiModulePath 
    });
    napiModule = null;
    return null;
  }
}

export async function parseMarkdownNAPI(
  html: string | null | undefined,
): Promise<string> {
  if (!html) {
    return "";
  }

  try {
    if (process.env.USE_GO_MARKDOWN_PARSER === "true") {
      const module = await loadNAPIModule();
      
      if (module) {
        // Use the N-API module with proper error handling
        try {
          let markdownContent: string;
          
          // Use async version for better performance
          if (module.convertAsync) {
            markdownContent = await new Promise<string>((resolve, reject) => {
              // Set a timeout to prevent hanging
              const timeout = setTimeout(() => {
                reject(new Error("N-API conversion timeout"));
              }, 30000); // 30 second timeout
              
              module.convertAsync(html, (error: Error | null, result?: string) => {
                clearTimeout(timeout);
                if (error) {
                  reject(error);
                } else {
                  resolve(result || "");
                }
              });
            });
          } else {
            // Fallback to sync version
            markdownContent = module.convertSync(html);
          }

          // Process the result
          markdownContent = processMultiLineLinks(markdownContent);
          markdownContent = removeSkipToContentLinks(markdownContent);
          
          logger.debug("HTML to Markdown conversion using N-API successful");
          return markdownContent;
        } catch (napiError) {
          logger.error("N-API conversion failed", { error: napiError });
          Sentry.captureException(napiError);
          // Fall through to JavaScript fallback
        }
      }
    }
  } catch (error) {
    logger.error(`Error with N-API HTML to Markdown converter: ${error}`);
    Sentry.captureException(error);
    // Fall through to JavaScript fallback
  }

  // Fallback to TurndownService if N-API fails or is not enabled
  const TurndownService = require("turndown");
  const turndownPluginGfm = require("joplin-turndown-plugin-gfm");

  const turndownService = new TurndownService();
  turndownService.addRule("inlineLink", {
    filter: function (node: any, options: any) {
      return (
        options.linkStyle === "inlined" &&
        node.nodeName === "A" &&
        node.getAttribute("href")
      );
    },
    replacement: function (content: string, node: any) {
      const href = node.getAttribute("href").trim();
      const title = node.title ? ' "' + node.title + '"' : "";
      return "[" + content.trim() + "](" + href + title + ")\n";
    },
  });
  
  const gfm = turndownPluginGfm.gfm;
  turndownService.use(gfm);

  try {
    let markdownContent = await turndownService.turndown(html);
    markdownContent = processMultiLineLinks(markdownContent);
    markdownContent = removeSkipToContentLinks(markdownContent);

    return markdownContent;
  } catch (error) {
    logger.error("Error converting HTML to Markdown with fallback", { error });
    return ""; // Return empty string if all methods fail
  }
}

function processMultiLineLinks(markdownContent: string): string {
  let insideLinkContent = false;
  let newMarkdownContent = "";
  let linkOpenCount = 0;
  
  for (let i = 0; i < markdownContent.length; i++) {
    const char = markdownContent[i];

    if (char === "[") {
      linkOpenCount++;
    } else if (char === "]") {
      linkOpenCount = Math.max(0, linkOpenCount - 1);
    }
    insideLinkContent = linkOpenCount > 0;

    if (insideLinkContent && char === "\n") {
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