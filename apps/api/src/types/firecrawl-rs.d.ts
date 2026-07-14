declare module '@mendable/firecrawl-rs' {
  export function html_to_markdown(html: string | null | undefined): any;
  export function html_transformer(html: string | null | undefined, options?: any): any;
  export function html_transformer_with_links(html: string | null | undefined, options?: any): any;
  export function extract_metadata(html: string | null | undefined, options?: any): any;
  export function extractMetadata(html: string | null | undefined, options?: any): any;
  export function parse_pdf(buffer: any, ...args: any[]): any;
  export function getInnerJson(html: string | null | undefined, ...args: any[]): any;
  export function processPdf(buffer: any, ...args: any[]): any;
  export function detectPdf(buffer: any, ...args: any[]): any;
  export function extractAttributes(html: string | null | undefined, ...args: any[]): any;
  export function extractImages(html: string | null | undefined, ...args: any[]): any;
  export function extractLinks(html: string | null | undefined, ...args: any[]): any;
  export function transformHtml(html: any, ...args: any[]): any;
  export function filterLinks(links: any, ...args: any[]): any;
  export function filterUrl(url: any, ...args: any[]): any;
  export function postProcessMarkdown(md: string | null | undefined): any;
  export function extractBaseHref(html: string | null | undefined, ...args: any[]): any;
  
  export function processSitemap(...args: any[]): any;
  export function parseSitemapXml(...args: any[]): any;
  export function computeEngpickerVerdict(...args: any[]): any;

  export enum DocumentType {
    Docx = 1,
    Doc,
    Odt,
    Rtf,
    Xlsx
  }
  export class DocumentConverter {
    constructor(...args: any[]);
    convertBufferToHtml(...args: any[]): any;
  }

  export type TransformHtmlOptions = any;
  export type EngpickerUrlResult = any;
  export type ParsedSitemap = any;
  export type SitemapProcessingResult = any;
}
