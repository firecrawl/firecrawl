//! Pure-Rust HTML-to-Markdown converter targeting clean CommonMark and GFM
//! output with bounded recursion depth and linear block-descendant detection.

mod block_map;
mod blocks;
mod code;
mod escape;
mod iframe;
mod inline;
mod list;
mod table;
mod tidy;

use kuchikiki::{NodeRef, parse_html, traits::TendrilSink};

use self::block_map::BlockMap;
use self::inline::InlineState;

pub use self::tidy::post_process_markdown;

/// How `data:` image URIs are emitted during conversion.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Base64ImageMode {
  /// Preserve `data:` URIs untouched so downstream filters can inspect or strip them.
  #[default]
  Keep,
  /// Replace `data:image/...;base64,...` URIs with `<Base64-Image-Removed>`.
  Placeholder,
  /// Omit `data:` images from the output.
  Drop,
}

/// How `<iframe>` elements are handled during conversion.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum IframeMode {
  /// Emit `[iframe](url)` links and convert `data:text/html` frames up to `max_iframe_depth`.
  #[default]
  Convert,
  /// Skip `<iframe>` elements completely.
  Skip,
}

/// Emphasis delimiter for `<em>` and `<i>`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum EmDelimiter {
  /// Use `*text*` (avoids collisions with `snake_case` identifiers).
  #[default]
  Asterisk,
  /// Use `_text_`.
  Underscore,
}

impl EmDelimiter {
  pub(crate) const fn as_str(self) -> &'static str {
    match self {
      Self::Asterisk => "*",
      Self::Underscore => "_",
    }
  }
}

/// Options controlling HTML-to-Markdown conversion.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkdownOptions {
  pub base64_images: Base64ImageMode,
  pub iframes: IframeMode,
  pub em_delimiter: EmDelimiter,
  pub strip_heading_permalinks: bool,
  pub unwrap_layout_tables: bool,
  pub max_dom_depth: usize,
  pub max_iframe_depth: usize,
  pub apply_post_process: bool,
}

impl Default for MarkdownOptions {
  fn default() -> Self {
    Self {
      base64_images: Base64ImageMode::Keep,
      iframes: IframeMode::Convert,
      em_delimiter: EmDelimiter::Asterisk,
      strip_heading_permalinks: true,
      unwrap_layout_tables: true,
      max_dom_depth: 512,
      max_iframe_depth: 2,
      apply_post_process: true,
    }
  }
}

pub(crate) struct RenderCtx<'a> {
  pub(crate) opts: &'a MarkdownOptions,
  pub(crate) block_map: BlockMap,
}

/// Convert an already-parsed `kuchikiki` DOM node without re-parsing HTML.
/// Never panics; degrades gracefully to iterative flat text past `max_dom_depth`.
pub fn node_to_markdown(root: &NodeRef, opts: &MarkdownOptions) -> String {
  let ctx = RenderCtx {
    opts,
    block_map: BlockMap::build(root, opts),
  };
  let rendered = blocks::render_blocks(&ctx, root, 0, InlineState::default()).join("\n\n");
  let cleaned = tidy::tidy(&rendered);
  if opts.apply_post_process {
    tidy::post_process_markdown(&cleaned)
  } else {
    cleaned
  }
}

/// Alias for [`node_to_markdown`] when passing a parsed document root.
pub fn document_to_markdown(document: &NodeRef, opts: &MarkdownOptions) -> String {
  node_to_markdown(document, opts)
}

/// Parse HTML and convert it to Markdown in a single call.
pub fn html_to_markdown(html: &str, opts: &MarkdownOptions) -> String {
  let doc = parse_html().one(html);
  node_to_markdown(&doc.document_node, opts)
}

/// Parse HTML, convert it to Markdown, and always apply [`post_process_markdown`].
pub fn html_to_markdown_postprocessed(html: &str, opts: &MarkdownOptions) -> String {
  let mut effective = opts.clone();
  effective.apply_post_process = true;
  html_to_markdown(html, &effective)
}
