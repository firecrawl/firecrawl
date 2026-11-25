//! CommonMark line-start escaping, link-label and plain-text bracket escaping,
//! and URL percent-encoding without intraword underscore over-escaping.

use std::borrow::Cow;

use kuchikiki::NodeRef;

/// Percent-encode characters that break inline Markdown link destinations and
/// strip ASCII tab/CR/LF bytes per WHATWG URL parsing.
pub(crate) fn encode_url(url: &str) -> String {
  let mut out = String::with_capacity(url.len());
  for ch in url.chars() {
    match ch {
      '\t' | '\r' | '\n' => {}
      ' ' => out.push_str("%20"),
      '(' => out.push_str("%28"),
      ')' => out.push_str("%29"),
      _ => out.push(ch),
    }
  }
  out
}

/// Match a URL scheme case-insensitively after stripping leading ASCII control
/// characters and embedded tab/CR/LF bytes (matching WHATWG URL parsing).
fn has_scheme(uri: &str, scheme: &[u8]) -> bool {
  let mut iter = uri
    .bytes()
    .skip_while(|&b| b <= 0x20)
    .filter(|&b| !matches!(b, b'\t' | b'\r' | b'\n'));
  for &expected in scheme {
    let Some(actual) = iter.next() else {
      return false;
    };
    if !actual.eq_ignore_ascii_case(&expected) {
      return false;
    }
  }
  true
}

pub(crate) fn is_javascript_uri(uri: &str) -> bool {
  has_scheme(uri, b"javascript:")
}

pub(crate) fn is_data_uri(uri: &str) -> bool {
  has_scheme(uri, b"data:")
}

pub(crate) fn is_base64_image_data_uri(uri: &str) -> bool {
  if !has_scheme(uri, b"data:image/") {
    return false;
  }
  uri
    .split_once(',')
    .is_some_and(|(meta, _)| meta.to_ascii_lowercase().contains(";base64"))
}

/// True when `line` is a CommonMark thematic break (`---`, `***`, `___`,
/// optionally spaced).
fn is_thematic_break(line: &str) -> bool {
  let mut marker: Option<u8> = None;
  let mut count = 0usize;
  for b in line.bytes() {
    match b {
      b' ' | b'\t' => {}
      b'-' | b'*' | b'_' => match marker {
        None => {
          marker = Some(b);
          count = 1;
        }
        Some(m) if m == b => count = count.saturating_add(1),
        Some(_) => return false,
      },
      _ => return false,
    }
  }
  count >= 3
}

/// Prevent plain paragraph lines from being parsed as headings, quotes, lists,
/// or thematic breaks. Ordered-list markers escape the `.` or `)` (`1\. `), not
/// the leading digit.
pub(crate) fn escape_line_starts(paragraph: &str) -> String {
  let mut out = String::with_capacity(paragraph.len().saturating_add(8));
  for (i, line) in paragraph.split('\n').enumerate() {
    if i > 0 {
      out.push('\n');
    }
    let bytes = line.as_bytes();
    if is_thematic_break(line) {
      out.push('\\');
      out.push_str(line);
      continue;
    }
    match bytes.first() {
      Some(b'#') => {
        let hashes = bytes.iter().take_while(|&&b| b == b'#').count();
        let atx = (1..=6).contains(&hashes)
          && match bytes.get(hashes) {
            None | Some(b' ') => true,
            Some(_) => false,
          };
        if atx {
          out.push('\\');
        }
        out.push_str(line);
      }
      Some(b'>') => {
        out.push('\\');
        out.push_str(line);
      }
      Some(b'-' | b'+' | b'*') => {
        if bytes.get(1) == Some(&b' ') || line.trim_end().bytes().all(|b| b == b'-') {
          out.push('\\');
        }
        out.push_str(line);
      }
      Some(b'=') if line.trim_end().bytes().all(|b| b == b'=') => {
        out.push('\\');
        out.push_str(line);
      }
      Some(c) if c.is_ascii_digit() => {
        let digits = bytes.iter().take_while(|&&b| b.is_ascii_digit()).count();
        let is_ol = (1..=9).contains(&digits)
          && matches!(bytes.get(digits), Some(b'.' | b')'))
          && match bytes.get(digits.saturating_add(1)) {
            None | Some(b' ') => true,
            Some(_) => false,
          };
        if is_ol {
          if let (Some(num), Some(rest)) = (line.get(..digits), line.get(digits..)) {
            out.push_str(num);
            out.push('\\');
            out.push_str(rest);
          } else {
            out.push_str(line);
          }
        } else {
          out.push_str(line);
        }
      }
      _ => out.push_str(line),
    }
  }
  out
}

/// Escape `[` and `]` inside link labels so text like `[1]` becomes `[\[1\]]`.
pub(crate) fn escape_link_label_text(text: &str) -> String {
  let mut out = String::with_capacity(text.len().saturating_add(4));
  for ch in text.chars() {
    if ch == '[' || ch == ']' {
      out.push('\\');
    }
    out.push(ch);
  }
  out
}

/// If a link label ends with an odd run of backslashes, append one more so the
/// closing `]` of `[label](href)` is never escaped.
pub(crate) fn guard_trailing_backslash(label: &str) -> Cow<'_, str> {
  let trailing = label.bytes().rev().take_while(|&b| b == b'\\').count();
  if trailing & 1 == 1 {
    let mut owned = String::with_capacity(label.len().saturating_add(1));
    owned.push_str(label);
    owned.push('\\');
    Cow::Owned(owned)
  } else {
    Cow::Borrowed(label)
  }
}

/// Escape a trailing ATX closing-hash sequence (` #` / ` ##`) at the end of a
/// heading without altering hashes inside words like `C#`.
pub(crate) fn escape_heading_trailing_hash(text: &str) -> Cow<'_, str> {
  if !text.ends_with('#') {
    return Cow::Borrowed(text);
  }
  let hash_count = text.bytes().rev().take_while(|&b| b == b'#').count();
  let prefix_len = text.len().saturating_sub(hash_count);
  let preceded_by_space = prefix_len > 0
    && text
      .as_bytes()
      .get(prefix_len.saturating_sub(1))
      .is_some_and(|&b| b == b' ');
  if !preceded_by_space {
    return Cow::Borrowed(text);
  }
  if let (Some(head), Some(tail)) = (text.get(..prefix_len), text.get(prefix_len..)) {
    let mut out = String::with_capacity(text.len().saturating_add(1));
    out.push_str(head);
    out.push('\\');
    out.push_str(tail);
    Cow::Owned(out)
  } else {
    Cow::Borrowed(text)
  }
}

/// True when the next sibling starts with a character that would turn a
/// preceding `]` into a Markdown link or reference (`(`, `[`, `:`).
pub(crate) fn next_sibling_continues_link(node: &NodeRef) -> bool {
  let Some(mut cur) = node.next_sibling() else {
    return false;
  };
  for _ in 0..8 {
    if let Some(t) = cur.as_text() {
      let s = t.borrow();
      if let Some(first) = s.bytes().next() {
        return matches!(first, b'(' | b'[' | b':');
      }
    } else if let Some(first_child) = cur.first_child() {
      cur = first_child;
      continue;
    }
    match cur.next_sibling() {
      Some(next) => cur = next,
      None => return false,
    }
  }
  false
}

/// Escape `[` and `]` in plain text when they would form an active Markdown
/// link/reference (`[...](...)`, `[...][...]`, `[...]:`), span a newline, or
/// leave brackets unbalanced (which would otherwise trip multiline link
/// post-processing). Balanced single-line `[0]` / `[Note]` stays unescaped.
pub(crate) fn escape_plain_text_brackets(text: &str, sibling_continues: bool) -> Cow<'_, str> {
  if !text.contains('[') && !text.contains(']') {
    return Cow::Borrowed(text);
  }

  let bytes = text.as_bytes();
  let mut escape_flags = vec![false; bytes.len()];
  let mut open_stack: Vec<usize> = Vec::new();
  let mut prev_closed_end: Option<usize> = None;

  for (idx, &b) in bytes.iter().enumerate() {
    match b {
      b'[' => open_stack.push(idx),
      b']' => {
        if let Some(open_idx) = open_stack.pop() {
          let next_byte = bytes.get(idx.saturating_add(1)).copied();
          let continued_by_next = matches!(next_byte, Some(b'(' | b'[' | b':'))
            || (next_byte.is_none() && sibling_continues);
          let spans_newline = text
            .get(open_idx..idx)
            .is_some_and(|slice| slice.contains('\n'));
          let follows_bracket_pair = prev_closed_end == Some(open_idx);
          if continued_by_next || spans_newline || follows_bracket_pair {
            if let Some(slot) = escape_flags.get_mut(open_idx) {
              *slot = true;
            }
            if let Some(slot) = escape_flags.get_mut(idx) {
              *slot = true;
            }
          }
          prev_closed_end = Some(idx.saturating_add(1));
        } else if let Some(slot) = escape_flags.get_mut(idx) {
          *slot = true;
        }
      }
      _ => {}
    }
  }

  for open_idx in open_stack {
    if let Some(slot) = escape_flags.get_mut(open_idx) {
      *slot = true;
    }
  }

  if !escape_flags.iter().any(|&f| f) {
    return Cow::Borrowed(text);
  }

  let mut out = String::with_capacity(text.len().saturating_add(8));
  for (idx, ch) in text.char_indices() {
    if escape_flags.get(idx).copied().unwrap_or(false) {
      out.push('\\');
    }
    out.push(ch);
  }
  Cow::Owned(out)
}
