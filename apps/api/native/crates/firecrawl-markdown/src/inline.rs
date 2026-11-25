//! Inline traversal: links (including icon fallback and image deduplication),
//! images (with configurable base64 handling), nested/multiline emphasis, code
//! spans, task-list checkboxes, and inline `<iframe>` delegates.

use kuchikiki::NodeRef;

use super::block_map::{
  attr, collapse_ws, collapse_ws_to_string, collect_flat_text_iterative, has_attr, is_block,
  is_skipped, normalize_inline, tag_of,
};
use super::escape::{
  encode_url, escape_link_label_text, escape_plain_text_brackets, guard_trailing_backslash,
  is_base64_image_data_uri, is_data_uri, is_javascript_uri, next_sibling_continues_link,
};
use super::iframe::render_iframe_inline;
use super::{Base64ImageMode, RenderCtx, code};

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct InlineState {
  pub(crate) in_strong: bool,
  pub(crate) in_em: bool,
  pub(crate) in_strike: bool,
  pub(crate) in_link: bool,
  pub(crate) in_heading: bool,
  pub(crate) iframe_depth: usize,
}

fn is_permalink_symbol(text: &str) -> bool {
  matches!(text.trim(), "¶" | "#" | "§" | "🔗" | "🔖" | "¤")
}

/// True when `trimmed` is a single `![alt](src)` image whose `src == encoded_href`.
pub(crate) fn is_single_matching_image(text: &str, encoded_href: &str) -> bool {
  let trimmed = text.trim();
  let Some(rest) = trimmed.strip_prefix("![") else {
    return false;
  };
  let Some((alt, after)) = rest.split_once("](") else {
    return false;
  };
  if alt.contains('[') || alt.contains(']') {
    return false;
  }
  let Some(src) = after.strip_suffix(')') else {
    return false;
  };
  if src.contains(')') {
    return false;
  }
  src == encoded_href
}

/// Fallback label text from `title` or `aria-label` for icon-only links.
pub(crate) fn link_fallback_label(node: &NodeRef) -> Option<String> {
  for attr_name in ["title", "aria-label"] {
    if let Some(raw) = attr(node, attr_name) {
      let collapsed = normalize_inline(&collapse_ws_to_string(&raw, true)).replace('\n', " ");
      if !collapsed.is_empty() {
        return Some(escape_link_label_text(&collapsed));
      }
    }
  }
  None
}

fn clean_img_alt(raw: &str) -> String {
  let cleaned = raw.replace(['\r', '\n', '[', ']'], " ");
  normalize_inline(&collapse_ws_to_string(&cleaned, true))
}

fn wrap_multiline(marker: &str, inner: &str) -> String {
  if inner.trim().is_empty() {
    return inner.to_string();
  }
  if !inner.contains('\n') {
    let lead = if inner.starts_with(char::is_whitespace) {
      " "
    } else {
      ""
    };
    let trail = if inner.ends_with(char::is_whitespace) {
      " "
    } else {
      ""
    };
    return format!("{lead}{marker}{}{marker}{trail}", inner.trim());
  }

  let mut out = String::with_capacity(inner.len().saturating_add(16));
  for (i, line) in inner.split('\n').enumerate() {
    if i > 0 {
      out.push('\n');
    }
    let trimmed = line.trim();
    if trimmed.is_empty() {
      continue;
    }
    if line.starts_with(char::is_whitespace) {
      out.push(' ');
    }
    out.push_str(marker);
    out.push_str(trimmed);
    out.push_str(marker);
    if line.ends_with(char::is_whitespace) {
      out.push(' ');
    }
  }
  out
}

fn is_task_list_checkbox(node: &NodeRef) -> bool {
  let is_checkbox = attr(node, "type").is_some_and(|t| t.trim().eq_ignore_ascii_case("checkbox"));
  if !is_checkbox {
    return false;
  }
  let Some(parent) = node.parent() else {
    return false;
  };
  match tag_of(&parent) {
    Some("li") => true,
    Some("p" | "label") => parent.parent().is_some_and(|gp| tag_of(&gp) == Some("li")),
    _ => false,
  }
}

pub(crate) fn inline_children(
  ctx: &RenderCtx<'_>,
  node: &NodeRef,
  state: InlineState,
  depth: usize,
) -> String {
  let mut out = String::new();
  if depth >= ctx.opts.max_dom_depth {
    collect_flat_text_iterative(node, ctx.opts, &mut out);
    return out;
  }
  let next_depth = depth.saturating_add(1);
  for child in node.children() {
    inline(ctx, &child, state, &mut out, next_depth);
  }
  out
}

pub(crate) fn inline(
  ctx: &RenderCtx<'_>,
  node: &NodeRef,
  state: InlineState,
  out: &mut String,
  depth: usize,
) {
  if depth >= ctx.opts.max_dom_depth {
    collect_flat_text_iterative(node, ctx.opts, out);
    return;
  }

  if let Some(text_node) = node.as_text() {
    let borrowed = text_node.borrow();
    if !borrowed.contains('[') && !borrowed.contains(']') {
      collapse_ws(&borrowed, out);
    } else {
      let last_space = out.ends_with(' ') || out.ends_with('\n');
      let collapsed = collapse_ws_to_string(&borrowed, last_space);
      if state.in_link {
        out.push_str(&escape_link_label_text(&collapsed));
      } else {
        let sib = next_sibling_continues_link(node);
        out.push_str(&escape_plain_text_brackets(&collapsed, sib));
      }
    }
    return;
  }

  let Some(name) = tag_of(node) else {
    if node.as_document().is_some() {
      let next_depth = depth.saturating_add(1);
      for child in node.children() {
        inline(ctx, &child, state, out, next_depth);
      }
    }
    return;
  };

  if name == "input" {
    if is_task_list_checkbox(node) {
      if has_attr(node, "checked") {
        out.push_str("[x] ");
      } else {
        out.push_str("[ ] ");
      }
    }
    return;
  }

  if name == "iframe" {
    render_iframe_inline(ctx, node, state, out);
    return;
  }

  if is_skipped(name, ctx.opts) {
    return;
  }

  let next_depth = depth.saturating_add(1);
  match name {
    "br" => out.push('\n'),
    "hr" => {
      if !state.in_heading && !state.in_link {
        out.push_str("\n\n---\n\n");
      }
    }
    "a" => render_inline_link(ctx, node, state, out, next_depth),
    "img" => render_img(ctx, node, out),
    "strong" | "b" => {
      if state.in_strong {
        for child in node.children() {
          inline(ctx, &child, state, out, next_depth);
        }
      } else {
        let inner = inline_children(
          ctx,
          node,
          InlineState {
            in_strong: true,
            ..state
          },
          depth,
        );
        out.push_str(&wrap_multiline("**", &inner));
      }
    }
    "em" | "i" | "cite" | "dfn" | "var" => {
      if state.in_em {
        for child in node.children() {
          inline(ctx, &child, state, out, next_depth);
        }
      } else {
        let inner = inline_children(
          ctx,
          node,
          InlineState {
            in_em: true,
            ..state
          },
          depth,
        );
        out.push_str(&wrap_multiline(ctx.opts.em_delimiter.as_str(), &inner));
      }
    }
    "del" | "s" | "strike" => {
      if state.in_strike {
        for child in node.children() {
          inline(ctx, &child, state, out, next_depth);
        }
      } else {
        let inner = inline_children(
          ctx,
          node,
          InlineState {
            in_strike: true,
            ..state
          },
          depth,
        );
        out.push_str(&wrap_multiline("~~", &inner));
      }
    }
    "code" | "kbd" | "samp" | "tt" => {
      let span = code::code_span(node, ctx.opts);
      if !span.is_empty() {
        if out.ends_with(|c: char| c.is_alphanumeric()) {
          out.push(' ');
        }
        out.push_str(&span);
      }
    }
    "pre" => {
      let block = code::code_block(node, ctx.opts);
      if !block.is_empty() {
        out.push('\n');
        out.push_str(&block);
        out.push('\n');
      }
    }
    _ if is_block(name) => {
      if !out.ends_with(' ') && !out.is_empty() {
        out.push(' ');
      }
      for child in node.children() {
        inline(ctx, &child, state, out, next_depth);
      }
      if !out.ends_with(' ') {
        out.push(' ');
      }
    }
    _ => {
      for child in node.children() {
        inline(ctx, &child, state, out, next_depth);
      }
    }
  }
}

fn render_inline_link(
  ctx: &RenderCtx<'_>,
  node: &NodeRef,
  state: InlineState,
  out: &mut String,
  depth: usize,
) {
  let href_raw = attr(node, "href").unwrap_or_default();
  let href = href_raw.trim();
  let navigable = !href.is_empty() && !is_javascript_uri(href) && href != "#";

  let link_state = InlineState {
    in_link: navigable || state.in_link,
    ..state
  };
  let mut text =
    normalize_inline(&inline_children(ctx, node, link_state, depth)).replace('\n', " ");
  let has_image = text.contains("![");

  if !has_image && text.is_empty() {
    text = link_fallback_label(node).unwrap_or_default();
  }

  if !has_image && text.is_empty() {
    return;
  }
  if ctx.opts.strip_heading_permalinks
    && !has_image
    && is_permalink_symbol(&text)
    && (state.in_heading || href.starts_with('#'))
  {
    return;
  }

  if !navigable {
    out.push_str(&text);
    return;
  }

  let encoded_href = encode_url(href);
  let has_title = attr(node, "title").is_some_and(|t| !t.trim().is_empty());
  if !has_title && is_single_matching_image(&text, &encoded_href) {
    out.push_str(text.trim());
    return;
  }

  let safe_label = guard_trailing_backslash(&text);
  out.push_str(&format!("[{safe_label}]({encoded_href})"));
}

fn render_img(ctx: &RenderCtx<'_>, node: &NodeRef, out: &mut String) {
  let src_raw = attr(node, "src").unwrap_or_default();
  let src = src_raw.trim();
  if src.is_empty() || is_javascript_uri(src) {
    return;
  }
  let alt = clean_img_alt(&attr(node, "alt").unwrap_or_default());

  if is_data_uri(src) {
    match ctx.opts.base64_images {
      Base64ImageMode::Drop => return,
      Base64ImageMode::Placeholder => {
        if is_base64_image_data_uri(src) {
          out.push_str(&format!("![{alt}](<Base64-Image-Removed>)"));
        } else {
          out.push_str(&format!("![{alt}]({})", encode_url(src)));
        }
        return;
      }
      Base64ImageMode::Keep => {
        out.push_str(&format!("![{alt}]({})", encode_url(src)));
        return;
      }
    }
  }

  out.push_str(&format!("![{alt}]({})", encode_url(src)));
}
