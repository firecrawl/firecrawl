//! Thin wrapper around the shared `firecrawl-markdown` crate configured with
//! Firecrawl Local defaults (drop inline data images, skip iframes, and leave
//! post-processing to `scrape.rs`).

#[cfg(vendored_native)]
use crate::firecrawl_markdown as core;
#[cfg(not(vendored_native))]
use firecrawl_markdown as core;

use kuchikiki::NodeRef;

pub use core::{post_process_markdown, Base64ImageMode, EmDelimiter, IframeMode, MarkdownOptions};

/// Default options for Firecrawl Local markdown conversion.
pub fn local_options() -> MarkdownOptions {
  MarkdownOptions {
    base64_images: Base64ImageMode::Drop,
    iframes: IframeMode::Skip,
    apply_post_process: false,
    ..MarkdownOptions::default()
  }
}

pub fn html_to_markdown(html: &str) -> String {
  core::html_to_markdown(html, &local_options())
}

/// Markdown for an already-parsed document.
pub fn document_to_markdown(document: &NodeRef) -> String {
  core::node_to_markdown(document, &local_options())
}
