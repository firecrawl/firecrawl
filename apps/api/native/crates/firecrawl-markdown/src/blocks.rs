//! Block-level DOM traversal with depth guarding, multi-block `<a>` card URL
//! preservation, headings, blockquotes, and `data:text/html` iframe handling.

use kuchikiki::NodeRef;

use super::block_map::{
  attr, collect_flat_text_iterative, is_block, is_skipped, normalize_inline, tag_of,
};
use super::escape::{
  encode_url, escape_heading_trailing_hash, escape_line_starts, escape_link_label_text,
  escape_plain_text_brackets, guard_trailing_backslash, is_javascript_uri,
};
use super::iframe::{is_data_text_html, render_data_iframe_blocks};
use super::inline::{
  InlineState, inline, inline_children, is_single_matching_image, link_fallback_label,
};
use super::{IframeMode, RenderCtx, code, list, table};

fn heading(
  ctx: &RenderCtx<'_>,
  node: &NodeRef,
  level: usize,
  depth: usize,
  state: InlineState,
) -> String {
  let heading_state = InlineState {
    in_heading: true,
    ..state
  };
  let raw = normalize_inline(&inline_children(ctx, node, heading_state, depth)).replace('\n', " ");
  if raw.is_empty() {
    return String::new();
  }
  let text = escape_heading_trailing_hash(&raw);
  format!("{} {text}", "#".repeat(level))
}

fn quote(ctx: &RenderCtx<'_>, node: &NodeRef, depth: usize, state: InlineState) -> String {
  let inner = render_blocks(ctx, node, depth, state).join("\n\n");
  if inner.is_empty() {
    return String::new();
  }
  inner
    .split('\n')
    .map(|line| {
      if line.is_empty() {
        ">".to_string()
      } else {
        format!("> {line}")
      }
    })
    .collect::<Vec<_>>()
    .join("\n")
}

/// Split a single-line ATX heading (`### Title`) into `("### ", "Title")`.
fn split_atx_heading(line: &str) -> Option<(&str, &str)> {
  let hashes = line.bytes().take_while(|&b| b == b'#').count();
  if !(1..=6).contains(&hashes) {
    return None;
  }
  if line.as_bytes().get(hashes) != Some(&b' ') {
    return None;
  }
  let prefix_len = hashes.saturating_add(1);
  let marks = line.get(..prefix_len)?;
  let rest = line.get(prefix_len..)?;
  Some((marks, rest))
}

/// Escape internal newlines inside a link card block without double-escaping
/// newlines already preceded by `\`.
fn escape_card_newlines(block: &str) -> String {
  if !block.contains('\n') {
    return block.to_string();
  }
  let mut out = String::with_capacity(block.len().saturating_add(8));
  let mut prev_backslash = false;
  for ch in block.chars() {
    if ch == '\n' {
      if !prev_backslash {
        out.push('\\');
      }
      out.push('\n');
      prev_backslash = false;
    } else {
      out.push(ch);
      prev_backslash = ch == '\\';
    }
  }
  out
}

/// Format one block inside a multi-block `<a>` card: convert single-line ATX
/// headings to bold (`**Title**`) and escape internal newlines.
fn format_card_block(block: &str) -> String {
  let trimmed = block.trim();
  let heading = (!trimmed.contains('\n'))
    .then(|| split_atx_heading(trimmed))
    .flatten();
  if let Some((_, text)) = heading {
    let text = text.trim();
    if text.is_empty() {
      return String::new();
    }
    if text.contains("**") {
      return text.to_string();
    }
    return format!("**{}**", guard_trailing_backslash(text));
  }
  escape_card_newlines(trimmed)
}

/// Render an `<a>` element that wraps one or more block-level descendants,
/// preserving the destination URL across both single-block and multi-block cards.
fn render_block_link(
  ctx: &RenderCtx<'_>,
  node: &NodeRef,
  depth: usize,
  state: InlineState,
) -> Vec<String> {
  let href_raw = attr(node, "href").unwrap_or_default();
  let href = href_raw.trim();
  let navigable = !href.is_empty() && !is_javascript_uri(href) && href != "#";

  let link_state = InlineState {
    in_link: navigable || state.in_link,
    ..state
  };
  let inner = render_blocks(ctx, node, depth, link_state);

  if !navigable {
    return inner;
  }

  let encoded_href = encode_url(href);
  if inner.is_empty() {
    if let Some(fallback) = link_fallback_label(node) {
      let safe = guard_trailing_backslash(&fallback);
      return vec![format!("[{safe}]({encoded_href})")];
    }
    return Vec::new();
  }

  let single_line = (inner.len() == 1)
    .then(|| inner.first())
    .flatten()
    .filter(|s| !s.contains('\n'));
  if let Some(single) = single_line {
    let has_title = attr(node, "title").is_some_and(|t| !t.trim().is_empty());
    if !has_title && is_single_matching_image(single, &encoded_href) {
      return vec![single.trim().to_string()];
    }
    if let Some((marks, text)) = split_atx_heading(single) {
      let safe = guard_trailing_backslash(text);
      return vec![format!("{marks}[{safe}]({encoded_href})")];
    }
    let safe = guard_trailing_backslash(single);
    return vec![format!("[{safe}]({encoded_href})")];
  }

  let card_parts: Vec<String> = inner
    .iter()
    .flat_map(|b| b.split("\n\n"))
    .map(format_card_block)
    .filter(|b| !b.is_empty())
    .collect();
  if card_parts.is_empty() {
    if let Some(fallback) = link_fallback_label(node) {
      let safe = guard_trailing_backslash(&fallback);
      return vec![format!("[{safe}]({encoded_href})")];
    }
    return Vec::new();
  }

  let joined = card_parts.join("\\\n\\\n");
  let safe = guard_trailing_backslash(&joined);
  vec![format!("[{safe}]({encoded_href})")]
}

fn render_depth_fallback(ctx: &RenderCtx<'_>, node: &NodeRef, state: InlineState) -> String {
  let mut flat = String::new();
  collect_flat_text_iterative(node, ctx.opts, &mut flat);
  let norm = normalize_inline(&flat);
  if norm.is_empty() {
    return String::new();
  }
  let safe = if state.in_link {
    escape_link_label_text(&norm)
  } else {
    escape_plain_text_brackets(&norm, false).into_owned()
  };
  escape_line_starts(&safe)
}

pub(crate) fn render_block(
  ctx: &RenderCtx<'_>,
  node: &NodeRef,
  name: &str,
  depth: usize,
  state: InlineState,
) -> String {
  if depth >= ctx.opts.max_dom_depth {
    return render_depth_fallback(ctx, node, state);
  }

  match name {
    "h1" => heading(ctx, node, 1, depth, state),
    "h2" => heading(ctx, node, 2, depth, state),
    "h3" => heading(ctx, node, 3, depth, state),
    "h4" => heading(ctx, node, 4, depth, state),
    "h5" => heading(ctx, node, 5, depth, state),
    "h6" => heading(ctx, node, 6, depth, state),
    "pre" => code::code_block(node, ctx.opts),
    "blockquote" => quote(ctx, node, depth, state),
    "ul" => list::render_list(ctx, node, false, depth, state),
    "ol" => list::render_list(ctx, node, true, depth, state),
    "table" => table::render_table(ctx, node, depth, state),
    "hr" => {
      if state.in_heading || state.in_link {
        String::new()
      } else {
        "---".to_string()
      }
    }
    "summary" => {
      let text = normalize_inline(&inline_children(ctx, node, state, depth)).replace('\n', " ");
      if text.is_empty() {
        String::new()
      } else if state.in_strong || text.contains("**") {
        text
      } else {
        format!("**{}**", guard_trailing_backslash(&text))
      }
    }
    _ => render_blocks(ctx, node, depth, state).join("\n\n"),
  }
}

/// Render a container's children as a sequence of Markdown blocks.
pub(crate) fn render_blocks(
  ctx: &RenderCtx<'_>,
  parent: &NodeRef,
  depth: usize,
  state: InlineState,
) -> Vec<String> {
  if depth >= ctx.opts.max_dom_depth {
    let text = render_depth_fallback(ctx, parent, state);
    return if text.is_empty() {
      Vec::new()
    } else {
      vec![text]
    };
  }

  let next_depth = depth.saturating_add(1);
  let mut out: Vec<String> = Vec::new();
  let mut run = String::new();

  let flush = |run: &mut String, out: &mut Vec<String>| {
    if !run.is_empty() {
      let paragraph = normalize_inline(run);
      if !paragraph.is_empty() {
        out.push(escape_line_starts(&paragraph));
      }
      run.clear();
    }
  };

  for child in parent.children() {
    if child.as_text().is_some() {
      inline(ctx, &child, state, &mut run, next_depth);
      continue;
    }

    let Some(name) = tag_of(&child) else {
      if child.as_document().is_some() {
        flush(&mut run, &mut out);
        out.extend(render_blocks(ctx, &child, next_depth, state));
      }
      continue;
    };

    if name == "input" {
      inline(ctx, &child, state, &mut run, next_depth);
      continue;
    }

    if name == "iframe" {
      if ctx.opts.iframes == IframeMode::Skip {
        continue;
      }
      let src_raw = attr(&child, "src").unwrap_or_default();
      let src = src_raw.trim();
      if is_data_text_html(src) {
        flush(&mut run, &mut out);
        out.extend(render_data_iframe_blocks(ctx, src, next_depth, state));
      } else {
        inline(ctx, &child, state, &mut run, next_depth);
      }
      continue;
    }

    if is_skipped(name, ctx.opts) {
      continue;
    }

    if is_block(name) {
      flush(&mut run, &mut out);
      let rendered = render_block(ctx, &child, name, next_depth, state);
      if !rendered.is_empty() {
        out.push(rendered);
      }
    } else if ctx.block_map.has_block(&child) {
      flush(&mut run, &mut out);
      if name == "a" {
        out.extend(render_block_link(ctx, &child, next_depth, state));
      } else {
        out.extend(render_blocks(ctx, &child, next_depth, state));
      }
    } else {
      inline(ctx, &child, state, &mut run, next_depth);
    }
  }

  flush(&mut run, &mut out);
  out
}
