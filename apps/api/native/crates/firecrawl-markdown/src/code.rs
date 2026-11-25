//! Fenced code block and inline code span extraction with syntax-highlighter
//! gutter stripping, block-element line breaks, dynamic backtick fencing, and
//! ancestor language detection.

use kuchikiki::NodeRef;

use super::MarkdownOptions;
use super::block_map::{attr, is_skipped, tag_of};

/// Longest contiguous run of ASCII backticks in `s`.
pub(crate) fn max_consecutive_backticks(s: &str) -> usize {
  let mut best = 0usize;
  let mut cur = 0usize;
  for b in s.bytes() {
    if b == b'`' {
      cur = cur.saturating_add(1);
      if cur > best {
        best = cur;
      }
    } else {
      cur = 0;
    }
  }
  best
}

/// True when an element's `class` identifies a line-number gutter.
pub(crate) fn is_gutter_class(node: &NodeRef) -> bool {
  let Some(classes) = attr(node, "class") else {
    return false;
  };
  let lower = classes.to_ascii_lowercase();
  lower.contains("gutter") || lower.contains("line-numbers")
}

/// True when an element inside `<pre>` is line-number or copy-button chrome.
fn is_code_chrome(node: &NodeRef, name: &str) -> bool {
  if is_gutter_class(node) {
    return true;
  }
  if name == "button" {
    if attr(node, "class").is_some_and(|c| c.to_ascii_lowercase().contains("copy")) {
      return true;
    }
    if attr(node, "aria-label").is_some_and(|l| l.to_ascii_lowercase().contains("copy")) {
      return true;
    }
  }
  false
}

fn is_pre_line_break_tag(name: &str) -> bool {
  matches!(
    name,
    "p"
      | "div"
      | "li"
      | "tr"
      | "table"
      | "thead"
      | "tbody"
      | "tfoot"
      | "section"
      | "article"
      | "blockquote"
      | "pre"
      | "h1"
      | "h2"
      | "h3"
      | "h4"
      | "h5"
      | "h6"
  )
}

fn clean_language(token: &str) -> Option<String> {
  let token = token.trim_matches(|c: char| !(c.is_ascii_alphanumeric() || c == '+' || c == '#'));
  if token.is_empty() || token.len() > 24 {
    return None;
  }
  let lower = token.to_ascii_lowercase();
  if matches!(
    lower.as_str(),
    "none"
      | "text"
      | "plain"
      | "plaintext"
      | "default"
      | "notranslate"
      | "highlight"
      | "code"
      | "wrap"
      | "nohighlight"
  ) {
    return None;
  }
  if lower
    .chars()
    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '#' | '-' | '_'))
  {
    Some(lower)
  } else {
    None
  }
}

fn language_from_classes(classes: &str, is_ancestor: bool) -> Option<String> {
  let tokens: Vec<String> = classes
    .split_whitespace()
    .map(str::to_ascii_lowercase)
    .collect();
  let is_sphinx_wrapper = tokens.iter().any(|t| t == "notranslate");

  for lower in &tokens {
    let prefixes: &[&str] = if is_ancestor {
      if is_sphinx_wrapper {
        &[
          "language-",
          "highlight-source-",
          "highlight-",
          "brush:",
          "sourcecode-",
          "hljs-language-",
        ]
      } else {
        &[
          "language-",
          "highlight-source-",
          "brush:",
          "sourcecode-",
          "hljs-language-",
        ]
      }
    } else {
      &[
        "language-",
        "lang-",
        "highlight-source-",
        "highlight-",
        "brush:",
        "sourcecode-",
        "hljs-language-",
      ]
    };
    for prefix in prefixes {
      if let Some(lang) = lower.strip_prefix(prefix).and_then(clean_language) {
        return Some(lang);
      }
    }
  }
  None
}

/// Find the first `<code>` descendant inside `<pre>` iteratively (bounded to
/// avoid walking into nested `<pre>` blocks).
fn first_inner_code(pre: &NodeRef) -> Option<NodeRef> {
  let mut stack: Vec<NodeRef> = Vec::new();
  let mut buf: Vec<NodeRef> = pre.children().collect();
  while let Some(child) = buf.pop() {
    stack.push(child);
  }
  while let Some(node) = stack.pop() {
    let Some(name) = tag_of(&node) else {
      continue;
    };
    if name == "code" {
      return Some(node);
    }
    if name == "pre" {
      continue;
    }
    buf.clear();
    buf.extend(node.children());
    while let Some(child) = buf.pop() {
      stack.push(child);
    }
  }
  None
}

fn code_language(pre: &NodeRef) -> Option<String> {
  let mut candidates: Vec<(NodeRef, bool)> = Vec::with_capacity(7);
  if let Some(code) = first_inner_code(pre) {
    candidates.push((code, false));
  }
  candidates.push((pre.clone(), false));
  let mut up = pre.parent();
  for _ in 0..5 {
    match up {
      Some(p) => {
        candidates.push((p.clone(), true));
        up = p.parent();
      }
      None => break,
    }
  }
  for (node, is_ancestor) in candidates {
    for name in ["class", "data-lang", "data-language"] {
      if let Some(value) = attr(&node, name) {
        let found = if name == "class" {
          language_from_classes(&value, is_ancestor)
        } else {
          clean_language(&value)
        };
        if found.is_some() {
          return found;
        }
      }
    }
  }
  None
}

/// Iteratively extract code text from `<pre>` or `<code>`, stripping gutters
/// and copy buttons while inserting line breaks after block-like children.
fn extract_code_text(root: &NodeRef, opts: &MarkdownOptions, block_breaks: bool) -> String {
  enum Frame {
    Enter(NodeRef),
    LeaveBlock { start_len: usize },
  }

  let mut out = String::new();
  let mut stack: Vec<Frame> = Vec::new();
  let mut buf: Vec<NodeRef> = root.children().collect();
  while let Some(child) = buf.pop() {
    stack.push(Frame::Enter(child));
  }

  while let Some(frame) = stack.pop() {
    match frame {
      Frame::LeaveBlock { start_len } => {
        if !out.is_empty() && (out.len() == start_len || !out.ends_with('\n')) {
          out.push('\n');
        }
      }
      Frame::Enter(node) => {
        if let Some(text) = node.as_text() {
          out.push_str(&text.borrow());
          continue;
        }
        let Some(name) = tag_of(&node) else {
          continue;
        };
        if is_skipped(name, opts) || is_code_chrome(&node, name) {
          continue;
        }
        if name == "br" {
          out.push('\n');
          continue;
        }
        if block_breaks && is_pre_line_break_tag(name) {
          stack.push(Frame::LeaveBlock {
            start_len: out.len(),
          });
        }
        buf.clear();
        buf.extend(node.children());
        while let Some(child) = buf.pop() {
          stack.push(Frame::Enter(child));
        }
      }
    }
  }

  out
}

/// Render an inline `<code>`, `<kbd>`, `<samp>`, or `<tt>` element with a
/// CommonMark-valid backtick delimiter strictly longer than any contained run.
pub(crate) fn code_span(node: &NodeRef, opts: &MarkdownOptions) -> String {
  let raw = extract_code_text(node, opts, false);
  let single_line = raw.replace("\r\n", " ").replace(['\r', '\n'], " ");
  let trimmed = single_line.trim();
  if trimmed.is_empty() {
    return String::new();
  }
  let max_run = max_consecutive_backticks(trimmed);
  let delim = "`".repeat(max_run.saturating_add(1));
  if trimmed.starts_with('`') || trimmed.ends_with('`') {
    format!("{delim} {trimmed} {delim}")
  } else {
    format!("{delim}{trimmed}{delim}")
  }
}

/// Render a `<pre>` element as a fenced code block with dynamic fence length
/// (`max(3, max_backtick_run + 1)`) and detected syntax language.
pub(crate) fn code_block(pre: &NodeRef, opts: &MarkdownOptions) -> String {
  let raw = extract_code_text(pre, opts, true);
  let normalized = raw.replace("\r\n", "\n").replace('\r', "\n");
  let text = normalized.trim_matches('\n').trim_end();
  if text.trim().is_empty() {
    return String::new();
  }
  let lang = code_language(pre).unwrap_or_default();
  let fence_len = max_consecutive_backticks(text).saturating_add(1).max(3);
  let fence = "`".repeat(fence_len);
  format!("{fence}{lang}\n{text}\n{fence}")
}
