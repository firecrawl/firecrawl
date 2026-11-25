//! Ordered and unordered list rendering with wrapper-`<li>` flattening,
//! non-`<li>` child preservation, and clean continuation indentation.

use kuchikiki::NodeRef;

use super::block_map::{
  attr, collapse_ws_to_string, collect_flat_text_iterative, is_block, is_skipped, normalize_inline,
  tag_of,
};
use super::blocks::{render_block, render_blocks};
use super::escape::escape_line_starts;
use super::inline::{InlineState, inline};
use super::{MarkdownOptions, RenderCtx};

fn indent_continuation(text: &str, width: usize) -> String {
  let pad = " ".repeat(width);
  let mut out = String::with_capacity(text.len());
  for (i, line) in text.split('\n').enumerate() {
    if i > 0 {
      out.push('\n');
      if !line.is_empty() {
        out.push_str(&pad);
      }
    }
    out.push_str(line);
  }
  out
}

/// True when `<li>` contains only nested `<ul>`/`<ol>` lists (plus optional
/// whitespace/comments/skipped nodes), so emitting a bullet would produce `- -`.
fn is_wrapper_li(li: &NodeRef, opts: &MarkdownOptions) -> bool {
  let mut saw_list = false;
  for child in li.children() {
    if let Some(text) = child.as_text() {
      if !text.borrow().trim().is_empty() {
        return false;
      }
      continue;
    }
    let Some(name) = tag_of(&child) else {
      continue;
    };
    if is_skipped(name, opts) {
      continue;
    }
    if matches!(name, "ul" | "ol") {
      saw_list = true;
    } else {
      return false;
    }
  }
  saw_list
}

fn marker_indent(item: &str) -> usize {
  let first = item.split('\n').next().unwrap_or("");
  if first.starts_with("- ") {
    return 2;
  }
  let bytes = first.as_bytes();
  let digits = bytes.iter().take_while(|&&b| b.is_ascii_digit()).count();
  if digits > 0
    && bytes.get(digits) == Some(&b'.')
    && bytes.get(digits.saturating_add(1)) == Some(&b' ')
  {
    return digits.saturating_add(2);
  }
  2
}

fn attach_nested_list(items: &mut Vec<String>, nested: String) {
  if nested.is_empty() {
    return;
  }
  match items.last_mut() {
    Some(last) => {
      let width = marker_indent(last);
      let pad = " ".repeat(width);
      last.push('\n');
      last.push_str(&indent_continuation(&format!("{pad}{nested}"), width));
    }
    None => items.push(nested),
  }
}

fn starts_with_list_marker(part: &str) -> bool {
  if part.starts_with("- ") {
    return true;
  }
  let bytes = part.as_bytes();
  let digits = bytes.iter().take_while(|&&b| b.is_ascii_digit()).count();
  digits > 0
    && bytes.get(digits) == Some(&b'.')
    && bytes.get(digits.saturating_add(1)) == Some(&b' ')
}

pub(crate) fn render_list(
  ctx: &RenderCtx<'_>,
  node: &NodeRef,
  ordered: bool,
  depth: usize,
  state: InlineState,
) -> String {
  if depth >= ctx.opts.max_dom_depth {
    let mut flat = String::new();
    collect_flat_text_iterative(node, ctx.opts, &mut flat);
    return normalize_inline(&flat);
  }

  let next_depth = depth.saturating_add(1);
  let mut number: usize = attr(node, "start")
    .and_then(|s| s.trim().parse().ok())
    .unwrap_or(1);
  let mut items: Vec<String> = Vec::new();

  for child in node.children() {
    if let Some(text) = child.as_text() {
      let norm = normalize_inline(&collapse_ws_to_string(&text.borrow(), true));
      if !norm.is_empty() {
        items.push(escape_line_starts(&norm));
      }
      continue;
    }

    let Some(name) = tag_of(&child) else {
      continue;
    };
    if is_skipped(name, ctx.opts) {
      continue;
    }

    match name {
      "li" => {
        if is_wrapper_li(&child, ctx.opts) {
          for sub in child.children() {
            if let Some(sub_name @ ("ul" | "ol")) = tag_of(&sub) {
              let nested = render_list(ctx, &sub, sub_name == "ol", next_depth, state);
              attach_nested_list(&mut items, nested);
            }
          }
          continue;
        }

        let parts = render_blocks(ctx, &child, next_depth, state);
        if parts.is_empty() {
          continue;
        }
        let mut body = String::new();
        for (i, part) in parts.iter().enumerate() {
          if i > 0 {
            body.push_str(if starts_with_list_marker(part) {
              "\n"
            } else {
              "\n\n"
            });
          }
          body.push_str(part);
        }
        let marker = if ordered {
          let m = format!("{number}. ");
          number = number.saturating_add(1);
          m
        } else {
          "- ".to_string()
        };
        let width = marker.len();
        items.push(format!("{marker}{}", indent_continuation(&body, width)));
      }
      "ul" | "ol" => {
        let nested = render_list(ctx, &child, name == "ol", next_depth, state);
        attach_nested_list(&mut items, nested);
      }
      _ if is_block(name) => {
        let rendered = render_block(ctx, &child, name, next_depth, state);
        if !rendered.is_empty() {
          items.push(rendered);
        }
      }
      _ if ctx.block_map.has_block(&child) => {
        items.extend(render_blocks(ctx, &child, next_depth, state));
      }
      _ => {
        let mut buf = String::new();
        inline(ctx, &child, state, &mut buf, next_depth);
        let norm = normalize_inline(&buf);
        if !norm.is_empty() {
          items.push(escape_line_starts(&norm));
        }
      }
    }
  }

  items.join("\n")
}

#[cfg(test)]
mod tests {
  use super::super::{MarkdownOptions, html_to_markdown};

  #[test]
  fn nested_ordered_list_uses_parent_marker_width() {
    let html = "<ol><li>One</li><ol><li>Sub A</li><li>Sub B</li></ol></ol>";
    assert_eq!(
      html_to_markdown(html, &MarkdownOptions::default()),
      "1. One\n   1. Sub A\n   2. Sub B"
    );

    let wide = "<ol start=\"10\"><li>Ten</li><li><ol><li>Sub</li></ol></li></ol>";
    assert_eq!(
      html_to_markdown(wide, &MarkdownOptions::default()),
      "10. Ten\n    1. Sub"
    );
  }
}
