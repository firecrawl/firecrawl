use std::collections::HashMap;

use crate::crawler::{
  FilterLinksCall, FilterLinksResult, FilterUrlCall, FilterUrlResult, ParsedSitemap,
  RegexValidationError, SitemapProcessingResult,
};
use crate::html::{ExtractAttributesOptions, ExtractedAttributeResult, TransformHtmlOptions};
use crate::parsers::{
  document::convert_document_bytes_to_markdown,
  pdf::{self, PdfProcessOutput},
};
use napi::bindgen_prelude::{Error, Result, Status, Uint8Array};
use serde_json::Value;
use tokio::task;

use super::logging::{NativeContext, NativeLogEntry, embed_logs_in_error, with_native_tracing};
use super::utils::to_napi_err;

#[derive(Debug, Clone)]
pub struct TracedPdfOutput {
  pub output: PdfProcessOutput,
  pub logs: Vec<NativeLogEntry>,
}

pub async fn extract_base_href(html: String, url: String) -> Result<String> {
  let res = task::spawn_blocking(move || crate::html::extract_base_href(&html, &url))
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
    crate::html::extract_links(&html).map_err(to_napi_err)
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
    crate::html::extract_metadata(&html).map_err(to_napi_err)
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
  let res = task::spawn_blocking(move || crate::html::transform_html(opts))
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
  let res = task::spawn_blocking(move || crate::html::get_inner_json(&html))
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
  let res = task::spawn_blocking(move || crate::html::extract_attributes(&html, &options))
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
  let res = task::spawn_blocking(move || crate::html::extract_images(&html, &base_url))
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
  task::spawn_blocking(move || crate::html::post_process_markdown_text(&markdown))
    .await
    .map_err(|e| {
      Error::new(
        Status::GenericFailure,
        format!("post_process_markdown join error: {e}"),
      )
    })
}

pub async fn filter_links(data: FilterLinksCall) -> Result<FilterLinksResult> {
  let res = task::spawn_blocking(move || crate::crawler::filter_links(data))
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
  crate::crawler::validate_regexes(patterns)
}

pub async fn filter_url(data: FilterUrlCall) -> Result<FilterUrlResult> {
  let res = task::spawn_blocking(move || crate::crawler::filter_url(data))
    .await
    .map_err(|e| {
      Error::new(
        Status::GenericFailure,
        format!("filter_url join error: {e}"),
      )
    })?;

  res.map_err(|e| Error::new(Status::GenericFailure, format!("Filter URL error: {e}")))
}

pub async fn parse_sitemap_xml(xml_content: String) -> Result<ParsedSitemap> {
  let res = task::spawn_blocking(move || crate::crawler::parse_sitemap_xml(&xml_content))
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
  let res = task::spawn_blocking(move || crate::crawler::process_sitemap(&xml_content))
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
      pdf::process_pdf_file(&path, max_pages).map_err(to_napi_err)
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
      pdf::detect_pdf_file(&path).map_err(to_napi_err)
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

    fn _convert_pdf_result(
      res: $crate::napi_exports::wrappers::TracedPdfOutput,
    ) -> PdfProcessResult {
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
      $crate::napi_exports::wrappers::extract_base_href(html, url).await
    }

    /// Extract all links from HTML document.
    #[napi_derive::napi]
    pub async fn extract_links(html: Option<String>) -> napi::Result<Vec<String>> {
      $crate::napi_exports::wrappers::extract_links(html).await
    }

    /// Extract metadata from HTML document.
    #[napi_derive::napi]
    pub async fn extract_metadata(
      html: Option<String>,
    ) -> napi::Result<std::collections::HashMap<String, serde_json::Value>> {
      $crate::napi_exports::wrappers::extract_metadata(html).await
    }

    /// Transform and clean HTML content based on provided options.
    #[napi_derive::napi]
    pub async fn transform_html(opts: TransformHtmlOptions) -> napi::Result<String> {
      $crate::napi_exports::wrappers::transform_html($crate::html::TransformHtmlOptions {
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
      $crate::napi_exports::wrappers::get_inner_json(html).await
    }

    /// Extract specified attributes from HTML elements matching selectors.
    #[napi_derive::napi]
    pub async fn extract_attributes(
      html: String,
      options: ExtractAttributesOptions,
    ) -> napi::Result<Vec<ExtractedAttributeResult>> {
      let res = $crate::napi_exports::wrappers::extract_attributes(
        html,
        $crate::html::ExtractAttributesOptions {
          selectors: options
            .selectors
            .into_iter()
            .map(|s| $crate::html::AttributeSelector {
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
      $crate::napi_exports::wrappers::extract_images(html, base_url).await
    }

    /// Process multi-line links in markdown.
    #[napi_derive::napi]
    pub async fn post_process_markdown(markdown: String) -> napi::Result<String> {
      $crate::napi_exports::wrappers::post_process_markdown(markdown).await
    }

    /// Filter links based on crawling rules and constraints.
    #[napi_derive::napi]
    pub async fn filter_links(data: FilterLinksCall) -> napi::Result<FilterLinksResult> {
      let res = $crate::napi_exports::wrappers::filter_links($crate::crawler::FilterLinksCall {
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
      $crate::napi_exports::wrappers::validate_regexes(patterns)
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
      let res = $crate::napi_exports::wrappers::filter_url($crate::crawler::FilterUrlCall {
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
      let res = $crate::napi_exports::wrappers::parse_sitemap_xml(xml_content).await?;

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
      let res = $crate::napi_exports::wrappers::process_sitemap(xml_content).await?;

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
      $crate::napi_exports::wrappers::convert_document_to_markdown(data, extension_hint).await
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
      let ctx = ctx.map(|c| $crate::napi_exports::logging::NativeContext {
        scrape_id: c.scrape_id,
        url: c.url,
      });
      let res = $crate::napi_exports::wrappers::process_pdf(path, max_pages, ctx).await?;
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
      let ctx = ctx.map(|c| $crate::napi_exports::logging::NativeContext {
        scrape_id: c.scrape_id,
        url: c.url,
      });
      let res = $crate::napi_exports::wrappers::detect_pdf(path, ctx).await?;
      Ok(_convert_pdf_result(res))
    }
  };
}
