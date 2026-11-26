import koffi from "koffi";
import type { IKoffiLib } from "koffi";
import { z } from "zod";
import { config } from "../config";
import { logger } from "./logger";
import type { Logger } from "winston";
import { stat } from "node:fs/promises";
import { HTML_TO_MARKDOWN_PATH } from "../natives";
import { convertHTMLToMarkdownWithHttpService } from "./html-to-markdown-client";
import { postProcessMarkdown } from "@mendable/firecrawl-rs";
export { getInnerJson } from "@mendable/firecrawl-rs";

type KoffiBoundFunction = ReturnType<IKoffiLib["func"]>;

interface TurndownNode {
  nodeName: string;
  title?: string;
  getAttribute(name: string): string | null;
}

interface TurndownOptions {
  linkStyle?: string;
}

interface TurndownRule {
  filter: (node: TurndownNode, options: TurndownOptions) => boolean;
  replacement: (content: string, node: TurndownNode) => string;
}

type TurndownPlugin = (service: TurndownInstance) => void;

interface TurndownInstance {
  addRule(key: string, rule: TurndownRule): this;
  use(plugin: TurndownPlugin): this;
  turndown(html: string): string;
}

type TurndownConstructor = new () => TurndownInstance;

const turndownConstructorSchema = z.custom<TurndownConstructor>(
  value => typeof value === "function",
);

const turndownModuleSchema = z.union([
  turndownConstructorSchema,
  z.object({ default: turndownConstructorSchema }).transform(m => m.default),
]);

const turndownPluginSchema = z.custom<TurndownPlugin>(
  value => typeof value === "function",
);

const gfmPluginModuleSchema = z.union([
  z.object({ gfm: turndownPluginSchema }).transform(m => m.gfm),
  z
    .object({ default: z.object({ gfm: turndownPluginSchema }) })
    .transform(m => m.default.gfm),
]);

// TODO: add a timeout to the Go parser

class GoMarkdownConverter {
  private static instance: GoMarkdownConverter;
  private convert: KoffiBoundFunction;
  private free: KoffiBoundFunction;

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
      } catch {
        throw Error("Go shared library not found");
      }
      GoMarkdownConverter.instance = new GoMarkdownConverter();
    }
    return GoMarkdownConverter.instance;
  }

  public async convertHTMLToMarkdown(html: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.convert.async(html, (err: Error | null, res: string) => {
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

  // Try HTTP service first if enabled
  if (config.HTML_TO_MARKDOWN_SERVICE_URL) {
    try {
      let markdownContent = await convertHTMLToMarkdownWithHttpService(html, {
        logger: contextLogger,
        requestId,
        zeroDataRetention,
      });
      markdownContent = await postProcessMarkdown(markdownContent);
      return markdownContent;
    } catch (error: unknown) {
      contextLogger.error(
        "Error converting HTML to Markdown with HTTP service, falling back to original parser",
        { error },
      );
    }
  }

  try {
    if (config.USE_GO_MARKDOWN_PARSER) {
      const converter = await GoMarkdownConverter.getInstance();
      let markdownContent = await converter.convertHTMLToMarkdown(html);
      markdownContent = await postProcessMarkdown(markdownContent);
      return markdownContent;
    }
  } catch (error: unknown) {
    if (
      !(error instanceof Error) ||
      error.message !== "Go shared library not found"
    ) {
      contextLogger.error("Error converting HTML to Markdown with Go parser", {
        error,
      });
    } else {
      contextLogger.warn(
        "Tried to use Go parser, but it doesn't exist in the file system.",
        { HTML_TO_MARKDOWN_PATH },
      );
    }
  }

  // Fallback to TurndownService if Go parser fails or is not enabled
  const turndownModule: unknown = await import("turndown");
  const turndownPluginGfmModule: unknown =
    await import("joplin-turndown-plugin-gfm");
  const parsedTurndown = turndownModuleSchema.safeParse(turndownModule);
  const parsedGfm = gfmPluginModuleSchema.safeParse(turndownPluginGfmModule);
  if (!parsedTurndown.success || !parsedGfm.success) {
    contextLogger.error(
      "Error loading Turndown fallback for HTML to Markdown conversion",
    );
    return "";
  }
  const TurndownService = parsedTurndown.data;
  const gfm = parsedGfm.data;

  const turndownService = new TurndownService();
  turndownService.addRule("inlineLink", {
    filter(node, options) {
      return (
        options.linkStyle === "inlined" &&
        node.nodeName === "A" &&
        Boolean(node.getAttribute("href"))
      );
    },
    replacement(content, node) {
      const href = (node.getAttribute("href") ?? "").trim();
      const title = node.title ? ' "' + node.title + '"' : "";
      return "[" + content.trim() + "](" + href + title + ")\n";
    },
  });
  turndownService.use(gfm);

  try {
    let markdownContent = turndownService.turndown(html);
    markdownContent = await postProcessMarkdown(markdownContent);

    return markdownContent;
  } catch (error: unknown) {
    contextLogger.error("Error converting HTML to Markdown", { error });
    return ""; // Optionally return an empty string or handle the error as needed
  }
}
