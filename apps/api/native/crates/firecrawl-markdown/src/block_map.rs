//! Single-pass iterative DOM precomputation (`BlockMap`), tag predicates,
//! and iterative flat-text extraction used past `max_dom_depth`.

use std::collections::HashSet;
use std::rc::Rc;

use kuchikiki::{Node, NodeRef};

use super::{IframeMode, MarkdownOptions};

const SKIPPED_ALWAYS: &[&str] = &[
  "script", "style", "noscript", "template", "svg", "head", "canvas", "object", "embed", "select",
  "textarea", "link", "meta", "title", "audio", "video", "source", "track", "map", "area", "math",
];

const BLOCKS: &[&str] = &[
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "caption",
  "center",
  "dd",
  "details",
  "dialog",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "html",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
];

pub(crate) fn tag_of(node: &NodeRef) -> Option<&str> {
  node.as_element().map(|e| e.name.local.as_ref())
}

pub(crate) fn attr(node: &NodeRef, name: &str) -> Option<String> {
  node
    .as_element()
    .and_then(|e| e.attributes.borrow().get(name).map(str::to_string))
}

pub(crate) fn has_attr(node: &NodeRef, name: &str) -> bool {
  node
    .as_element()
    .is_some_and(|e| e.attributes.borrow().get(name).is_some())
}

pub(crate) fn is_block(name: &str) -> bool {
  BLOCKS.contains(&name)
}

pub(crate) fn is_skipped(name: &str, opts: &MarkdownOptions) -> bool {
  if SKIPPED_ALWAYS.contains(&name) {
    return true;
  }
  name == "iframe" && opts.iframes == IframeMode::Skip
}

fn node_ptr(node: &NodeRef) -> *const Node {
  Rc::as_ptr(&node.0)
}

/// Precomputed per-node structural flags built in one iterative O(N) pass.
pub(crate) struct BlockMap {
  has_block: HashSet<*const Node>,
  has_nested_table: HashSet<*const Node>,
}

impl BlockMap {
  pub(crate) fn build(root: &NodeRef, opts: &MarkdownOptions) -> Self {
    let mut has_block: HashSet<*const Node> = HashSet::new();
    let mut contains_table: HashSet<*const Node> = HashSet::new();
    let mut has_nested_table: HashSet<*const Node> = HashSet::new();
    let mut stack: Vec<(NodeRef, bool)> = vec![(root.clone(), false)];

    while let Some((node, visited)) = stack.pop() {
      if !visited {
        if tag_of(&node).is_some_and(|name| is_skipped(name, opts)) {
          continue;
        }
        stack.push((node.clone(), true));
        for child in node.children() {
          if child.as_element().is_some() || child.as_document().is_some() {
            stack.push((child, false));
          }
        }
        continue;
      }

      let mut child_has_block = false;
      let mut child_has_table = false;
      for child in node.children() {
        let Some(child_name) = tag_of(&child) else {
          continue;
        };
        if is_skipped(child_name, opts) {
          continue;
        }
        let cptr = node_ptr(&child);
        if is_block(child_name) || has_block.contains(&cptr) {
          child_has_block = true;
        }
        if child_name == "table" || contains_table.contains(&cptr) {
          child_has_table = true;
        }
      }

      let ptr = node_ptr(&node);
      if child_has_block {
        has_block.insert(ptr);
      }
      if child_has_table {
        if tag_of(&node) == Some("table") {
          has_nested_table.insert(ptr);
        }
        contains_table.insert(ptr);
      } else if tag_of(&node) == Some("table") {
        contains_table.insert(ptr);
      }
    }

    Self {
      has_block,
      has_nested_table,
    }
  }

  pub(crate) fn has_block(&self, node: &NodeRef) -> bool {
    self.has_block.contains(&node_ptr(node))
  }

  pub(crate) fn has_nested_table(&self, node: &NodeRef) -> bool {
    self.has_nested_table.contains(&node_ptr(node))
  }
}

/// Collapse every run of whitespace into a single ASCII space.
pub(crate) fn collapse_ws(text: &str, out: &mut String) {
  let mut last_space = out.ends_with(' ') || out.ends_with('\n');
  for ch in text.chars() {
    if ch.is_whitespace() {
      if !last_space {
        out.push(' ');
        last_space = true;
      }
    } else {
      out.push(ch);
      last_space = false;
    }
  }
}

/// Collapse whitespace into a new string starting from a caller-provided boundary state.
pub(crate) fn collapse_ws_to_string(text: &str, mut last_space: bool) -> String {
  let mut out = String::with_capacity(text.len());
  for ch in text.chars() {
    if ch.is_whitespace() {
      if !last_space {
        out.push(' ');
        last_space = true;
      }
    } else {
      out.push(ch);
      last_space = false;
    }
  }
  out
}

/// Normalize one inline paragraph: trim lines, collapse doubled spaces, and
/// collapse stray blank lines left by consecutive `<br>` tags.
pub(crate) fn normalize_inline(text: &str) -> String {
  let mut out = String::with_capacity(text.len());
  for (i, line) in text.split('\n').enumerate() {
    if i > 0 {
      out.push('\n');
    }
    let mut last_space = true;
    for ch in line.trim().chars() {
      if ch == ' ' {
        if !last_space {
          out.push(' ');
        }
        last_space = true;
      } else {
        out.push(ch);
        last_space = false;
      }
    }
  }
  let trimmed = out.trim_matches(|c: char| c == '\n' || c == ' ');
  let mut result = String::with_capacity(trimmed.len());
  let mut newline_run = 0usize;
  for ch in trimmed.chars() {
    if ch == '\n' {
      newline_run = newline_run.saturating_add(1);
      if newline_run > 1 {
        continue;
      }
    } else {
      newline_run = 0;
    }
    result.push(ch);
  }
  result
}

/// Extract visible text iteratively without call-stack recursion.
pub(crate) fn collect_flat_text_iterative(
  root: &NodeRef,
  opts: &MarkdownOptions,
  out: &mut String,
) {
  enum Frame {
    Node(NodeRef),
    Space,
  }

  let mut stack: Vec<Frame> = vec![Frame::Node(root.clone())];
  let mut children_buf: Vec<NodeRef> = Vec::new();

  while let Some(frame) = stack.pop() {
    match frame {
      Frame::Space => {
        if !out.is_empty() && !out.ends_with(' ') && !out.ends_with('\n') {
          out.push(' ');
        }
      }
      Frame::Node(node) => {
        if let Some(text) = node.as_text() {
          collapse_ws(&text.borrow(), out);
          continue;
        }
        if let Some(name) = tag_of(&node) {
          if is_skipped(name, opts) || name == "input" {
            continue;
          }
          if name == "br" {
            out.push('\n');
            continue;
          }
          if is_block(name) {
            if !out.is_empty() && !out.ends_with(' ') && !out.ends_with('\n') {
              out.push(' ');
            }
            stack.push(Frame::Space);
          }
        } else if node.as_document().is_none() {
          continue;
        }
        children_buf.clear();
        children_buf.extend(node.children());
        while let Some(child) = children_buf.pop() {
          stack.push(Frame::Node(child));
        }
      }
    }
  }
}
