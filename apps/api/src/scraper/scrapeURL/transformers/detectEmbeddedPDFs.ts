/*
this file will detect embedded PDFs in HTML content, scrapes them, and merges their content.

*/

import { Meta } from "..";
import { Document } from "../../../controllers/v2/types";
import { Logger } from "winston";
import * as cheerio from "cheerio";
import { scrapePDF } from "../engines/pdf";

/**
 * Detects embedded PDFs in HTML content, scrapes them, and merges their content
 * Looks for:
 * - <embed src="*.pdf">
 * - <iframe src="*.pdf">
 * - <object data="*.pdf">
 */
export async function detectEmbeddedPDFs(
  meta: Meta,
  document: Document,
): Promise<Document> {
  if (!document.rawHtml && !document.html) {
    return document;
  }

  const html = document.rawHtml || document.html;
  if (!html) {
    return document;
  }

  const $ = cheerio.load(html);
  const pdfUrls: string[] = [];

  // Check for <embed> tags with PDF sources
  $("embed").each((_, element) => {
    const src = $(element).attr("src");
    const type = $(element).attr("type");
    if (
      src &&
      (src.toLowerCase().includes(".pdf") || type === "application/pdf")
    ) {
      pdfUrls.push(resolveUrl(src, document.metadata?.sourceURL || meta.url));
    }
  });

  // Check for <iframe> tags with PDF sources
  $("iframe").each((_, element) => {
    const src = $(element).attr("src");
    if (src && src.toLowerCase().includes(".pdf")) {
      pdfUrls.push(resolveUrl(src, document.metadata?.sourceURL || meta.url));
    }
  });

  // Check for <object> tags with PDF data
  $("object").each((_, element) => {
    const data = $(element).attr("data");
    const type = $(element).attr("type");
    if (
      data &&
      (data.toLowerCase().includes(".pdf") || type === "application/pdf")
    ) {
      pdfUrls.push(resolveUrl(data, document.metadata?.sourceURL || meta.url));
    }
  });

  // Add detected PDFs to document.actions.pdfs
  if (pdfUrls.length > 0) {
    meta.logger.info("Detected embedded PDFs - scraping them now", {
      count: pdfUrls.length,
      urls: pdfUrls,
      sourceUrl: meta.url,
    });

    // Scrape each detected PDF and merge content
    const pdfContents: string[] = [];

    for (const pdfUrl of pdfUrls) {
      try {
        meta.logger.info("Scraping embedded PDF", { url: pdfUrl });

        // Create a new meta object for the PDF scrape with the PDF URL
        const pdfMeta: Meta = {
          ...meta,
          url: pdfUrl,
          logger: meta.logger.child({ embeddedPDF: pdfUrl }),
        };

        // Scrape the PDF using the existing PDF engine
        const pdfResult = await scrapePDF(pdfMeta);

        if (pdfResult && pdfResult.markdown) {
          pdfContents.push(pdfResult.markdown);
          meta.logger.info("Successfully scraped embedded PDF", {
            url: pdfUrl,
            contentLength: pdfResult.markdown.length,
          });
        }
      } catch (error) {
        meta.logger.warn("Failed to scrape embedded PDF", {
          url: pdfUrl,
          error: error.message,
        });
        // Continue with other PDFs even if one fails
      }
    }

    // Merge PDF content with existing markdown
    if (pdfContents.length > 0) {
      const separator = "\n\n---\n\n# Embedded PDF Content\n\n";
      document.markdown =
        (document.markdown || "") + separator + pdfContents.join("\n\n---\n\n");

      meta.logger.info("Merged embedded PDF content into markdown", {
        pdfCount: pdfContents.length,
        totalLength: document.markdown.length,
      });
    }

    // Still add URLs to actions for reference
    document.actions = document.actions || {};
    document.actions.pdfs = [
      ...(document.actions.pdfs || []),
      ...pdfUrls.filter((url, index, self) => self.indexOf(url) === index), // Remove duplicates
    ];
  }

  return document;
}

/**
 * Resolves a potentially relative URL to an absolute URL
 */
function resolveUrl(url: string, baseUrl: string): string {
  try {
    // If URL is already absolute, return it
    if (
      url.startsWith("http://") ||
      url.startsWith("https://") ||
      url.startsWith("data:")
    ) {
      return url;
    }

    // If URL starts with //, add protocol
    if (url.startsWith("//")) {
      const baseProtocol = new URL(baseUrl).protocol;
      return `${baseProtocol}${url}`;
    }

    // Resolve relative URL
    const base = new URL(baseUrl);
    if (url.startsWith("/")) {
      // Absolute path
      return `${base.protocol}//${base.host}${url}`;
    } else {
      // Relative path
      const basePath = base.pathname.substring(
        0,
        base.pathname.lastIndexOf("/") + 1,
      );
      return `${base.protocol}//${base.host}${basePath}${url}`;
    }
  } catch (error) {
    return url;
  }
}
