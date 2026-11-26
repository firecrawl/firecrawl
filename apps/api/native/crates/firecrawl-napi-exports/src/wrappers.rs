use std::collections::HashMap;

use firecrawl_crawler::{
  CrawlScope, FilterLinksCall, FilterLinksResult, FilterUrlCall, FilterUrlResult, FilterUrlsCall,
  ParsedSitemap, RegexValidationError, SitemapProcessingResult,
};
use firecrawl_html::{ExtractAttributesOptions, ExtractedAttributeResult, TransformHtmlOptions};
use firecrawl_parsers::{PdfProcessOutput, convert_document_bytes_to_markdown};
use napi::bindgen_prelude::{Error, Result, Status, Uint8Array};
use serde_json::Value;
use tokio::task;

use crate::logging::{NativeContext, NativeLogEntry, embed_logs_in_error, with_native_tracing};
use crate::utils::to_napi_err;

#[derive(Debug, Clone)]
pub struct TracedPdfOutput {
  pub output: PdfProcessOutput,
  pub logs: Vec<NativeLogEntry>,
}

pub async fn extract_base_href(html: String, url: String) -> Result<String> {
  let res = task::spawn_blocking(move || firecrawl_html::extract_base_href(&html, &url))
    .await
    .map_err(|e| {
      Error::new(
        Status::GenericFailure,
        format!("extract_base_href join error: {e}"),
      )
    })?;

  res.map_err(to_napi_err)
}

pub async fn extract_links(html: Option<String>) -> Result<Vec<String>> {
  task::spawn_blocking(move || {
    let Some(html) = html else {
      return Ok(Vec::new());
    };
    firecrawl_html::extract_links(&html).map_err(to_napi_err)
  })
  .await
  .map_err(|e| {
    Error::new(
      Status::GenericFailure,
      format!("extract_links join error: {e}"),
    )
  })?
}

pub async fn extract_metadata(html: Option<String>) -> Result<HashMap<String, Value>> {
  task::spawn_blocking(move || {
    let Some(html) = html else {
      return Ok(HashMap::new());
    };
    firecrawl_html::extract_metadata(&html).map_err(to_napi_err)
  })
  .await
  .map_err(|e| {
    Error::new(
      Status::GenericFailure,
      format!("extract_metadata join error: {e}"),
    )
  })?
}

pub async fn transform_html(opts: TransformHtmlOptions) -> Result<String> {
  let res = task::spawn_blocking(move || firecrawl_html::transform_html(opts))
    .await
    .map_err(|e| {
      Error::new(
        Status::GenericFailure,
        format!("transform_html join error: {e}"),
      )
    })?;

  res.map_err(to_napi_err)
}

pub async fn get_inner_json(html: String) -> Result<String> {
  let res = task::spawn_blocking(move || firecrawl_html::get_inner_json(&html))
    .await
    .map_err(|e| {
      Error::new(
        Status::GenericFailure,
        format!("get_inner_json join error: {e}"),
      )
    })?;

  res.map_err(to_napi_err)
}

pub async fn extract_attributes(
  html: String,
  options: ExtractAttributesOptions,
) -> Result<Vec<ExtractedAttributeResult>> {
  let res = task::spawn_blocking(move || firecrawl_html::extract_attributes(&html, &options))
    .await
    .map_err(|e| {
      Error::new(
        Status::GenericFailure,
        format!("extract_attributes join error: {e}"),
      )
    })?;

  res.map_err(to_napi_err)
}

pub async fn extract_images(html: String, base_url: String) -> Result<Vec<String>> {
  let res = task::spawn_blocking(move || firecrawl_html::extract_images(&html, &base_url))
    .await
    .map_err(|e| {
      Error::new(
        Status::GenericFailure,
        format!("extract_images join error: {e}"),
      )
    })?;

  res.map_err(to_napi_err)
}

pub async fn post_process_markdown(markdown: String) -> Result<String> {
  task::spawn_blocking(move || firecrawl_html::post_process_markdown_text(&markdown))
    .await
    .map_err(|e| {
      Error::new(
        Status::GenericFailure,
        format!("post_process_markdown join error: {e}"),
      )
    })
}

pub async fn filter_links(data: FilterLinksCall) -> Result<FilterLinksResult> {
  let res = task::spawn_blocking(move || firecrawl_crawler::filter_links(data))
    .await
    .map_err(|e| {
      Error::new(
        Status::GenericFailure,
        format!("filter_links join error: {e}"),
      )
    })?;

  res.map_err(|e| Error::new(Status::GenericFailure, format!("Filter links error: {e}")))
}

pub fn validate_regexes(patterns: Vec<String>) -> Vec<RegexValidationError> {
  firecrawl_crawler::validate_regexes(patterns)
}

pub async fn filter_url(data: FilterUrlCall) -> Result<FilterUrlResult> {
  let res = task::spawn_blocking(move || firecrawl_crawler::filter_url(data))
    .await
    .map_err(|e| {
      Error::new(
        Status::GenericFailure,
        format!("filter_url join error: {e}"),
      )
    })?;

  res.map_err(|e| Error::new(Status::GenericFailure, format!("Filter URL error: {e}")))
}

pub async fn filter_urls(data: FilterUrlsCall) -> Result<Vec<String>> {
  let res = task::spawn_blocking(move || firecrawl_crawler::filter_urls(data))
    .await
    .map_err(|e| {
      Error::new(
        Status::GenericFailure,
        format!("filter_urls join error: {e}"),
      )
    })?;

  res.map_err(|e| Error::new(Status::GenericFailure, format!("Filter URLs error: {e}")))
}

pub fn get_crawl_scope(initial_url: String) -> CrawlScope {
  firecrawl_crawler::get_crawl_scope(&initial_url)
}

pub fn extract_links_from_markdown(text: String, base_url: String) -> Vec<String> {
  firecrawl_crawler::extract_links_from_markdown(&text, &base_url)
}

pub async fn parse_sitemap_xml(xml_content: String) -> Result<ParsedSitemap> {
  let res = task::spawn_blocking(move || firecrawl_crawler::parse_sitemap_xml(&xml_content))
    .await
    .map_err(|e| {
      Error::new(
        Status::GenericFailure,
        format!("parse_sitemap_xml join error: {e}"),
      )
    })?;

  res.map_err(|e| {
    Error::new(
      Status::GenericFailure,
      format!("Parse sitemap XML error: {e}"),
    )
  })
}

pub async fn process_sitemap(xml_content: String) -> Result<SitemapProcessingResult> {
  let res = task::spawn_blocking(move || firecrawl_crawler::process_sitemap(&xml_content))
    .await
    .map_err(|e| {
      Error::new(
        Status::GenericFailure,
        format!("process_sitemap join error: {e}"),
      )
    })?;

  res.map_err(|e| Error::new(Status::GenericFailure, format!("Parse sitemap error: {e}")))
}

pub async fn convert_document_to_markdown(
  data: Uint8Array,
  extension_hint: Option<String>,
) -> Result<String> {
  let bytes = data.to_vec();
  task::spawn_blocking(move || {
    convert_document_bytes_to_markdown(&bytes, extension_hint).map_err(to_napi_err)
  })
  .await
  .map_err(|e| {
    Error::new(
      Status::GenericFailure,
      format!("Document conversion task failed: {e}"),
    )
  })?
}

pub async fn process_pdf(
  path: String,
  max_pages: Option<u32>,
  ctx: Option<NativeContext>,
) -> Result<TracedPdfOutput> {
  task::spawn_blocking(move || {
    let traced = with_native_tracing(ctx.as_ref(), "pdf", || {
      firecrawl_parsers::process_pdf_file(&path, max_pages).map_err(to_napi_err)
    });

    match traced.value {
      Ok(output) => Ok(TracedPdfOutput {
        output,
        logs: traced.logs,
      }),
      Err(err) => Err(embed_logs_in_error(err, &traced.logs)),
    }
  })
  .await
  .map_err(|e| {
    Error::new(
      Status::GenericFailure,
      format!("PDF processing task failed to complete: {e}"),
    )
  })?
}

pub async fn detect_pdf(path: String, ctx: Option<NativeContext>) -> Result<TracedPdfOutput> {
  task::spawn_blocking(move || {
    let traced = with_native_tracing(ctx.as_ref(), "pdf", || {
      firecrawl_parsers::detect_pdf_file(&path).map_err(to_napi_err)
    });

    match traced.value {
      Ok(output) => Ok(TracedPdfOutput {
        output,
        logs: traced.logs,
      }),
      Err(err) => Err(embed_logs_in_error(err, &traced.logs)),
    }
  })
  .await
  .map_err(|e| {
    Error::new(
      Status::GenericFailure,
      format!("PDF detection task failed to complete: {e}"),
    )
  })?
}

/// Emits all core `@mendable/firecrawl-rs` N-API types and functions directly
/// into the invoking `cdylib` crate so `napi-rs` registers every export and
/// emits complete TypeScript definitions on both cold and incremental builds.
#[macro_export]
macro_rules! export_oss_napi {
  () => {
    #[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
    #[napi_derive::napi(object)]
    pub struct TransformHtmlOptions {
      pub html: String,
      pub url: String,
      #[serde(default)]
      pub include_tags: Vec<String>,
      #[serde(default)]
      pub exclude_tags: Vec<String>,
      pub only_main_content: bool,
      pub omce_signatures: Option<Vec<String>>,
    }

    #[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
    #[napi_derive::napi(object)]
    pub struct AttributeSelector {
      pub selector: String,
      pub attribute: String,
    }

    #[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
    #[napi_derive::napi(object)]
    pub struct ExtractAttributesOptions {
      pub selectors: Vec<AttributeSelector>,
    }

    #[derive(Debug, Clone, serde::Serialize)]
    #[napi_derive::napi(object)]
    pub struct ExtractedAttributeResult {
      pub selector: String,
      pub attribute: String,
      pub values: Vec<String>,
    }

    #[derive(Debug, Clone, serde::Deserialize)]
    #[napi_derive::napi(object)]
    pub struct FilterLinksCall {
      pub links: Vec<String>,
      pub limit: Option<i64>,
      pub max_depth: u32,
      pub base_url: String,
      pub initial_url: String,
      pub regex_on_full_url: bool,
      pub excludes: Vec<String>,
      pub includes: Vec<String>,
      pub allow_backward_crawling: bool,
      pub ignore_robots_txt: bool,
      pub robots_txt: String,
      pub robots_user_agent: Option<String>,
      pub allow_external_content_links: bool,
      pub allow_subdomains: bool,
    }

    #[derive(Debug, Clone, serde::Serialize)]
    #[napi_derive::napi(object)]
    pub struct FilterLinksResult {
      pub links: Vec<String>,
      pub denial_reasons: std::collections::HashMap<String, String>,
    }

    #[derive(Debug, Clone, serde::Serialize)]
    #[napi_derive::napi(object)]
    pub struct RegexValidationError {
      pub pattern: String,
      pub error: String,
    }

    #[derive(Debug, Clone, serde::Deserialize)]
    #[napi_derive::napi(object)]
    pub struct FilterUrlCall {
      pub href: String,
      pub url: String,
      pub base_url: String,
      pub excludes: Vec<String>,
      pub ignore_robots_txt: bool,
      pub robots_txt: String,
      pub robots_user_agent: Option<String>,
      pub allow_external_content_links: bool,
      pub allow_subdomains: bool,
    }

    #[derive(Debug, Clone, serde::Serialize)]
    #[napi_derive::napi(object)]
    pub struct FilterUrlResult {
      pub allowed: bool,
      pub url: Option<String>,
      pub denial_reason: Option<String>,
    }

    #[derive(Debug, Clone, serde::Serialize)]
    #[napi_derive::napi(object)]
    pub struct SitemapUrl {
      pub loc: Vec<String>,
    }

    #[derive(Debug, Clone, serde::Serialize)]
    #[napi_derive::napi(object)]
    pub struct SitemapEntry {
      pub loc: Vec<String>,
    }

    #[derive(Debug, Clone, serde::Serialize)]
    #[napi_derive::napi(object)]
    pub struct SitemapUrlset {
      pub url: Vec<SitemapUrl>,
    }

    #[derive(Debug, Clone, serde::Serialize)]
    #[napi_derive::napi(object)]
    pub struct SitemapIndex {
      pub sitemap: Vec<SitemapEntry>,
    }

    #[derive(Debug, Clone, serde::Serialize)]
    #[napi_derive::napi(object)]
    pub struct ParsedSitemap {
      pub urlset: Option<SitemapUrlset>,
      pub sitemapindex: Option<SitemapIndex>,
    }

    #[derive(Debug, Clone, serde::Serialize)]
    #[napi_derive::napi(object)]
    pub struct SitemapInstruction {
      pub action: String,
      pub urls: Vec<String>,
      pub count: u32,
    }

    #[derive(Debug, Clone, serde::Serialize)]
    #[napi_derive::napi(object)]
    pub struct SitemapProcessingResult {
      pub instructions: Vec<SitemapInstruction>,
      pub total_count: u32,
    }

    /// Context passed from TypeScript to continue the trace.
    #[derive(Debug, Clone)]
    #[napi_derive::napi(object)]
    pub struct NativeContext {
      pub scrape_id: String,
      pub url: String,
    }

    /// A single log entry captured during Rust execution.
    #[derive(Debug, Clone, serde::Serialize)]
    #[napi_derive::napi(object)]
    pub struct NativeLogEntry {
      pub level: String,
      pub target: String,
      pub message: String,
      pub fields: serde_json::Value,
      pub timestamp_ms: f64,
    }

    #[derive(Debug, Clone)]
    #[napi_derive::napi(object)]
    pub struct PdfProcessResult {
      pub pdf_type: String,
      pub markdown: Option<String>,
      pub page_count: i32,
      pub processing_time_ms: f64,
      pub pages_needing_ocr: Vec<i32>,
      pub title: Option<String>,
      pub confidence: f64,
      pub is_complex: bool,
      pub logs: Vec<NativeLogEntry>,
    }

    fn _convert_pdf_result(res: $crate::wrappers::TracedPdfOutput) -> PdfProcessResult {
      PdfProcessResult {
        pdf_type: res.output.pdf_type,
        markdown: res.output.markdown,
        page_count: res.output.page_count,
        processing_time_ms: res.output.processing_time_ms,
        pages_needing_ocr: res.output.pages_needing_ocr,
        title: res.output.title,
        confidence: res.output.confidence,
        is_complex: res.output.is_complex,
        logs: res
          .logs
          .into_iter()
          .map(|entry| NativeLogEntry {
            level: entry.level,
            target: entry.target,
            message: entry.message,
            fields: entry.fields,
            timestamp_ms: entry.timestamp_ms,
          })
          .collect(),
      }
    }

    /// Extract the base href from HTML document.
    #[napi_derive::napi]
    pub async fn extract_base_href(html: String, url: String) -> napi::Result<String> {
      $crate::wrappers::extract_base_href(html, url).await
    }

    /// Extract all links from HTML document.
    #[napi_derive::napi]
    pub async fn extract_links(html: Option<String>) -> napi::Result<Vec<String>> {
      $crate::wrappers::extract_links(html).await
    }

    /// Extract metadata from HTML document.
    #[napi_derive::napi]
    pub async fn extract_metadata(
      html: Option<String>,
    ) -> napi::Result<std::collections::HashMap<String, serde_json::Value>> {
      $crate::wrappers::extract_metadata(html).await
    }

    /// Transform and clean HTML content based on provided options.
    #[napi_derive::napi]
    pub async fn transform_html(opts: TransformHtmlOptions) -> napi::Result<String> {
      $crate::wrappers::transform_html($crate::__deps::firecrawl_html::TransformHtmlOptions {
        html: opts.html,
        url: opts.url,
        include_tags: opts.include_tags,
        exclude_tags: opts.exclude_tags,
        only_main_content: opts.only_main_content,
        omce_signatures: opts.omce_signatures,
      })
      .await
    }

    /// Extract inner text content from HTML body.
    #[napi_derive::napi]
    pub async fn get_inner_json(html: String) -> napi::Result<String> {
      $crate::wrappers::get_inner_json(html).await
    }

    /// Extract specified attributes from HTML elements matching selectors.
    #[napi_derive::napi]
    pub async fn extract_attributes(
      html: String,
      options: ExtractAttributesOptions,
    ) -> napi::Result<Vec<ExtractedAttributeResult>> {
      let res = $crate::wrappers::extract_attributes(
        html,
        $crate::__deps::firecrawl_html::ExtractAttributesOptions {
          selectors: options
            .selectors
            .into_iter()
            .map(|s| $crate::__deps::firecrawl_html::AttributeSelector {
              selector: s.selector,
              attribute: s.attribute,
            })
            .collect(),
        },
      )
      .await?;

      Ok(
        res
          .into_iter()
          .map(|r| ExtractedAttributeResult {
            selector: r.selector,
            attribute: r.attribute,
            values: r.values,
          })
          .collect(),
      )
    }

    /// Extract all image URLs from HTML document.
    #[napi_derive::napi]
    pub async fn extract_images(html: String, base_url: String) -> napi::Result<Vec<String>> {
      $crate::wrappers::extract_images(html, base_url).await
    }

    /// Process multi-line links in markdown.
    #[napi_derive::napi]
    pub async fn post_process_markdown(markdown: String) -> napi::Result<String> {
      $crate::wrappers::post_process_markdown(markdown).await
    }

    /// Filter links based on crawling rules and constraints.
    #[napi_derive::napi]
    pub async fn filter_links(data: FilterLinksCall) -> napi::Result<FilterLinksResult> {
      let res =
        $crate::wrappers::filter_links($crate::__deps::firecrawl_crawler::FilterLinksCall {
          links: data.links,
          limit: data.limit,
          max_depth: data.max_depth,
          base_url: data.base_url,
          initial_url: data.initial_url,
          regex_on_full_url: data.regex_on_full_url,
          excludes: data.excludes,
          includes: data.includes,
          allow_backward_crawling: data.allow_backward_crawling,
          ignore_robots_txt: data.ignore_robots_txt,
          robots_txt: data.robots_txt,
          robots_user_agent: data.robots_user_agent,
          allow_external_content_links: data.allow_external_content_links,
          allow_subdomains: data.allow_subdomains,
        })
        .await?;

      Ok(FilterLinksResult {
        links: res.links,
        denial_reasons: res.denial_reasons,
      })
    }

    /// Validate regex patterns against the engine's regex flavor (the Rust `regex`
    /// crate), which is what link filtering compiles them with. Returns an entry for
    /// each pattern that fails to compile so callers can reject unsupported syntax
    /// (e.g. look-around, backreferences) instead of silently ignoring it.
    #[napi_derive::napi]
    pub fn validate_regexes(patterns: Vec<String>) -> Vec<RegexValidationError> {
      $crate::wrappers::validate_regexes(patterns)
        .into_iter()
        .map(|e| RegexValidationError {
          pattern: e.pattern,
          error: e.error,
        })
        .collect()
    }

    /// Filter a single URL based on crawling rules and constraints.
    #[napi_derive::napi]
    pub async fn filter_url(data: FilterUrlCall) -> napi::Result<FilterUrlResult> {
      let res = $crate::wrappers::filter_url($crate::__deps::firecrawl_crawler::FilterUrlCall {
        href: data.href,
        url: data.url,
        base_url: data.base_url,
        excludes: data.excludes,
        ignore_robots_txt: data.ignore_robots_txt,
        robots_txt: data.robots_txt,
        robots_user_agent: data.robots_user_agent,
        allow_external_content_links: data.allow_external_content_links,
        allow_subdomains: data.allow_subdomains,
      })
      .await?;

      Ok(FilterUrlResult {
        allowed: res.allowed,
        url: res.url,
        denial_reason: res.denial_reason,
      })
    }

    /// Parse XML sitemap content into structured data.
    #[napi_derive::napi]
    pub async fn parse_sitemap_xml(xml_content: String) -> napi::Result<ParsedSitemap> {
      let res = $crate::wrappers::parse_sitemap_xml(xml_content).await?;

      Ok(ParsedSitemap {
        urlset: res.urlset.map(|u| SitemapUrlset {
          url: u
            .url
            .into_iter()
            .map(|entry| SitemapUrl { loc: entry.loc })
            .collect(),
        }),
        sitemapindex: res.sitemapindex.map(|idx| SitemapIndex {
          sitemap: idx
            .sitemap
            .into_iter()
            .map(|entry| SitemapEntry { loc: entry.loc })
            .collect(),
        }),
      })
    }

    /// Process sitemap XML and extract crawling instructions.
    #[napi_derive::napi]
    pub async fn process_sitemap(xml_content: String) -> napi::Result<SitemapProcessingResult> {
      let res = $crate::wrappers::process_sitemap(xml_content).await?;

      Ok(SitemapProcessingResult {
        instructions: res
          .instructions
          .into_iter()
          .map(|inst| SitemapInstruction {
            action: inst.action,
            urls: inst.urls,
            count: inst.count,
          })
          .collect(),
        total_count: res.total_count,
      })
    }

    /// Convert a document (doc, docx, odt/ods/odp, rtf, xls/xlsx, ppt/pptx, epub,
    /// csv, ...) to GitHub-Flavored Markdown using anydoc. The format is detected
    /// from the file content; `extension_hint` (with or without a leading dot) is
    /// only consulted for signature-less formats like CSV.
    ///
    /// Runs on tokio's blocking thread pool, like the PDF functions: conversion is
    /// CPU-bound and would otherwise hold the Node.js event loop for its duration.
    #[napi_derive::napi]
    pub async fn convert_document_to_markdown(
      data: napi::bindgen_prelude::Uint8Array,
      extension_hint: Option<String>,
    ) -> napi::Result<String> {
      $crate::wrappers::convert_document_to_markdown(data, extension_hint).await
    }

    /// Process a PDF file: detect type, extract text + markdown if text-based.
    /// When `max_pages` is provided, only the first N pages are extracted.
    /// Pass `ctx` (NativeContext) for structured tracing with scrape_id/url.
    ///
    /// Runs on tokio's blocking thread pool: extraction is CPU-bound and can take
    /// tens of seconds on large PDFs, which would otherwise freeze the Node.js
    /// event loop (and every in-flight request on the process) for the duration.
    #[napi_derive::napi]
    pub async fn process_pdf(
      path: String,
      max_pages: Option<u32>,
      ctx: Option<NativeContext>,
    ) -> napi::Result<PdfProcessResult> {
      let ctx = ctx.map(|c| $crate::logging::NativeContext {
        scrape_id: c.scrape_id,
        url: c.url,
      });
      let res = $crate::wrappers::process_pdf(path, max_pages, ctx).await?;
      Ok(_convert_pdf_result(res))
    }

    /// Fast metadata-only detection: page count, title, type, confidence.
    /// Skips text extraction, markdown generation, and layout analysis.
    /// Pass `ctx` (NativeContext) for structured tracing with scrape_id/url.
    ///
    /// Offloaded to tokio's blocking pool for the same reason as `process_pdf`:
    /// even metadata-only parsing can be slow on huge or malformed PDFs.
    #[napi_derive::napi]
    pub async fn detect_pdf(
      path: String,
      ctx: Option<NativeContext>,
    ) -> napi::Result<PdfProcessResult> {
      let ctx = ctx.map(|c| $crate::logging::NativeContext {
        scrape_id: c.scrape_id,
        url: c.url,
      });
      let res = $crate::wrappers::detect_pdf(path, ctx).await?;
      Ok(_convert_pdf_result(res))
    }

    #[derive(Debug, Clone, serde::Deserialize)]
    #[napi_derive::napi(object)]
    pub struct FilterUrlsCall {
      pub hrefs: Vec<String>,
      pub url: String,
      pub base_url: String,
      pub excludes: Vec<String>,
      pub ignore_robots_txt: bool,
      pub robots_txt: String,
      pub robots_user_agent: Option<String>,
      pub allow_external_content_links: bool,
      pub allow_subdomains: bool,
    }

    #[derive(Debug, Clone, serde::Serialize)]
    #[napi_derive::napi(object)]
    pub struct CrawlScope {
      pub prefix: String,
      pub exact: Option<String>,
    }

    /// Parsed `robots.txt` evaluator backed by pure-Rust RFC 9309 matching.
    #[derive(Debug)]
    #[napi_derive::napi]
    pub struct RobotsParser {
      inner: $crate::__deps::firecrawl_crawler::Robots,
    }

    #[napi_derive::napi]
    impl RobotsParser {
      #[napi_derive::napi(constructor)]
      pub fn new(robots_txt_url: String, contents: String) -> Self {
        Self {
          inner: $crate::__deps::firecrawl_crawler::Robots::parse(&robots_txt_url, &contents),
        }
      }

      #[napi_derive::napi]
      pub fn is_allowed(&self, url: String, user_agent: Option<String>) -> Option<bool> {
        self.inner.is_allowed(&url, user_agent.as_deref())
      }

      #[napi_derive::napi]
      pub fn is_disallowed(&self, url: String, user_agent: Option<String>) -> bool {
        self.inner.is_disallowed(&url, user_agent.as_deref())
      }

      #[napi_derive::napi]
      pub fn get_matching_line_number(&self, url: String, user_agent: Option<String>) -> i32 {
        self
          .inner
          .get_matching_line_number(&url, user_agent.as_deref())
      }

      #[napi_derive::napi]
      pub fn get_crawl_delay(&self, user_agent: Option<String>) -> Option<f64> {
        self.inner.get_crawl_delay(user_agent.as_deref())
      }

      #[napi_derive::napi]
      pub fn get_sitemaps(&self) -> Vec<String> {
        self.inner.get_sitemaps().to_vec()
      }

      #[napi_derive::napi]
      pub fn get_preferred_host(&self) -> Option<String> {
        self.inner.get_preferred_host().map(str::to_string)
      }

      #[napi_derive::napi]
      pub fn is_url_allowed_by_robots(
        &self,
        url: String,
        user_agents: Option<Vec<String>>,
      ) -> bool {
        self
          .inner
          .is_url_allowed_by_robots(&url, user_agents.as_deref())
      }

      #[napi_derive::napi]
      pub fn filter_urls_allowed(
        &self,
        urls: Vec<String>,
        user_agents: Option<Vec<String>>,
      ) -> Vec<bool> {
        self
          .inner
          .filter_urls_allowed(&urls, user_agents.as_deref())
      }
    }

    /// Batch-filter candidate hrefs extracted from a single page.
    #[napi_derive::napi]
    pub async fn filter_urls(data: FilterUrlsCall) -> napi::Result<Vec<String>> {
      $crate::wrappers::filter_urls($crate::__deps::firecrawl_crawler::FilterUrlsCall {
        hrefs: data.hrefs,
        url: data.url,
        base_url: data.base_url,
        excludes: data.excludes,
        ignore_robots_txt: data.ignore_robots_txt,
        robots_txt: data.robots_txt,
        robots_user_agent: data.robots_user_agent,
        allow_external_content_links: data.allow_external_content_links,
        allow_subdomains: data.allow_subdomains,
      })
      .await
    }

    /// Resolve the path scope for a crawl when backward crawling is disabled.
    #[napi_derive::napi]
    pub fn get_crawl_scope(initial_url: String) -> CrawlScope {
      let scope = $crate::wrappers::get_crawl_scope(initial_url);
      CrawlScope {
        prefix: scope.prefix,
        exact: scope.exact,
      }
    }

    /// Extract deduplicated resolved links from markdown or plaintext content.
    #[napi_derive::napi]
    pub fn extract_links_from_markdown(text: String, base_url: String) -> Vec<String> {
      $crate::wrappers::extract_links_from_markdown(text, base_url)
    }
  };
}
