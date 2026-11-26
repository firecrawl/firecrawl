//! Pure-Rust markdown link extractor (excluding images and code spans/blocks).

use std::{collections::HashSet, sync::LazyLock};

use regex::Regex;
use url::Url;

#[allow(clippy::expect_used)]
fn compile_static_regex(pattern: &str, name: &str) -> Regex {
  Regex::new(pattern).expect(name)
}

static IMAGE: LazyLock<Regex> =
  LazyLock::new(|| compile_static_regex(r"!\[[^\]]*\]\([^)]*\)", "valid IMAGE regex"));
static INLINE_LINK: LazyLock<Regex> = LazyLock::new(|| {
  compile_static_regex(
    r#"\[[^\]]*\]\(\s*(<[^>\n]*>|[^)\s]+)(?:\s+["'][^"']*["'])?\s*\)"#,
    "valid INLINE_LINK regex",
  )
});
static REFERENCE_DEFINITION: LazyLock<Regex> = LazyLock::new(|| {
  compile_static_regex(
    r"(?m)^[ \t]{0,3}\[[^\]]+\]:[ \t]*(<[^>]+>|\S+)",
    "valid REFERENCE_DEFINITION regex",
  )
});
static AUTOLINK: LazyLock<Regex> = LazyLock::new(|| {
  compile_static_regex(r"<((?:https?://|mailto:)[^>\s]+)>", "valid AUTOLINK regex")
});
static BARE_URL: LazyLock<Regex> = LazyLock::new(|| {
  compile_static_regex(
    r#"(?:^|[\s(<])(https?://[^\s<>"'`)\]]+)"#,
    "valid BARE_URL regex",
  )
});

/// Extracts deduplicated resolved links from a markdown or plaintext body,
/// excluding images, fenced code blocks, and inline code spans.
#[must_use]
pub fn extract_links_from_markdown(text: &str, base_url: &str) -> Vec<String> {
  let stripped = strip_code(text);
  let body = IMAGE.replace_all(&stripped, " ");

  let base = Url::parse(base_url).ok();
  let mut seen: HashSet<String> = HashSet::new();
  let mut links: Vec<String> = Vec::new();

  let mut push = |href: &str, trim_punctuation: bool| {
    let Some(resolved) = resolve_href(href, base.as_ref(), trim_punctuation) else {
      return;
    };
    if seen.insert(resolved.clone()) {
      links.push(resolved);
    }
  };

  for cap in INLINE_LINK.captures_iter(&body) {
    if let Some(m) = cap.get(1) {
      push(m.as_str(), false);
    }
  }
  for cap in REFERENCE_DEFINITION.captures_iter(&body) {
    if let Some(m) = cap.get(1) {
      push(m.as_str(), false);
    }
  }
  for cap in AUTOLINK.captures_iter(&body) {
    if let Some(m) = cap.get(1) {
      push(m.as_str(), false);
    }
  }
  for cap in BARE_URL.captures_iter(&body) {
    if let Some(m) = cap.get(1) {
      push(m.as_str(), true);
    }
  }

  links
}

fn resolve_href(href: &str, base: Option<&Url>, trim_punctuation: bool) -> Option<String> {
  let mut candidate = href.trim();

  if let Some(inner) = candidate
    .strip_prefix('<')
    .and_then(|s| s.strip_suffix('>'))
  {
    candidate = inner.trim();
  }

  if trim_punctuation {
    candidate = candidate.trim_end_matches(['.', ',', ';', ':', '!', '?']);
  }

  if candidate.is_empty() || candidate.starts_with('#') {
    return None;
  }

  if let Some(base_url) = base {
    base_url.join(candidate).ok().map(String::from)
  } else {
    Url::parse(candidate).ok().map(String::from)
  }
}

fn strip_code(text: &str) -> String {
  let mut out: Vec<String> = Vec::new();
  let mut fence: Option<(u8, usize)> = None;

  for line in text.split('\n') {
    let matched_fence = parse_fence_prefix(line);

    if let Some((fence_byte, fence_len)) = fence {
      let closes = matched_fence.is_some_and(|(b, len, after_idx)| {
        b == fence_byte
          && len >= fence_len
          && line.get(after_idx..).is_some_and(|s| s.trim().is_empty())
      });
      if closes {
        fence = None;
      }
      out.push(String::new());
      continue;
    }

    if let Some((b, len, _)) = matched_fence {
      fence = Some((b, len));
      out.push(String::new());
      continue;
    }

    out.push(strip_inline_code(line));
  }

  out.join("\n")
}

/// Matches `^[ \t]{0,3}(`{3,}|~{3,})`, returning `(fence_byte, run_len, end_idx)`.
fn parse_fence_prefix(line: &str) -> Option<(u8, usize, usize)> {
  let bytes = line.as_bytes();
  let mut idx = 0usize;
  while idx < 3 {
    match bytes.get(idx) {
      Some(&b' ' | &b'\t') => idx = idx.saturating_add(1),
      _ => break,
    }
  }
  let &fence_byte = bytes.get(idx)?;
  if fence_byte != b'`' && fence_byte != b'~' {
    return None;
  }
  let start = idx;
  while bytes.get(idx) == Some(&fence_byte) {
    idx = idx.saturating_add(1);
  }
  let len = idx.saturating_sub(start);
  (len >= 3).then_some((fence_byte, len, idx))
}

struct RunIndex {
  size: usize,
  tree: Vec<usize>,
  suffix_max: Vec<usize>,
}

impl RunIndex {
  fn new(runs: &[(usize, usize)]) -> Self {
    let n = runs.len();
    let mut suffix_max = vec![0usize; n];
    let mut running_max = 0usize;
    for idx in (0..n).rev() {
      if let Some(slot) = suffix_max.get_mut(idx) {
        *slot = running_max;
      }
      if let Some(&(_, len)) = runs.get(idx) {
        running_max = running_max.max(len);
      }
    }

    let size = n.next_power_of_two();
    let mut tree = vec![0usize; size.saturating_mul(2)];
    for (idx, &(_, len)) in runs.iter().enumerate() {
      if let Some(slot) = tree.get_mut(size.saturating_add(idx)) {
        *slot = len;
      }
    }
    for idx in (1..size).rev() {
      let left = tree.get(idx.saturating_mul(2)).copied().unwrap_or(0);
      let right = tree
        .get(idx.saturating_mul(2).saturating_add(1))
        .copied()
        .unwrap_or(0);
      if let Some(slot) = tree.get_mut(idx) {
        *slot = left.max(right);
      }
    }

    Self {
      size,
      tree,
      suffix_max,
    }
  }

  fn max_after(&self, idx: usize) -> usize {
    self.suffix_max.get(idx).copied().unwrap_or(0)
  }

  fn first_ge(&self, from: usize, target: usize) -> Option<usize> {
    if from >= self.size || target == 0 {
      return None;
    }
    self.first_ge_rec(1, 0, self.size, from, target)
  }

  fn first_ge_rec(
    &self,
    node: usize,
    lo: usize,
    hi: usize,
    from: usize,
    target: usize,
  ) -> Option<usize> {
    if hi <= from || self.tree.get(node).copied().unwrap_or(0) < target {
      return None;
    }
    if hi.saturating_sub(lo) == 1 {
      return Some(lo);
    }
    let mid = lo.saturating_add(hi.saturating_sub(lo) / 2);
    let left_child = node.saturating_mul(2);
    self
      .first_ge_rec(left_child, lo, mid, from, target)
      .or_else(|| self.first_ge_rec(left_child.saturating_add(1), mid, hi, from, target))
  }
}

/// O(N + R log R) replacement equivalent to JS `line.replace(/(`+)(?:(?!\1)[^\n])*\1/g, " ")`.
fn strip_inline_code(line: &str) -> String {
  if !line.contains('`') {
    return line.to_string();
  }

  let bytes = line.as_bytes();
  let mut runs: Vec<(usize, usize)> = Vec::new();
  let mut scan = 0usize;
  while let Some(&b) = bytes.get(scan) {
    if b == b'`' {
      let start = scan;
      while bytes.get(scan) == Some(&b'`') {
        scan = scan.saturating_add(1);
      }
      runs.push((start, scan.saturating_sub(start)));
    } else {
      scan = scan.saturating_add(1);
    }
  }

  let index = RunIndex::new(&runs);
  let mut out = String::with_capacity(line.len());
  let mut cursor = 0usize;
  let mut run_idx = 0usize;

  while let Some(&(start, len)) = runs.get(run_idx) {
    let eff_start = start.max(cursor);
    let eff_len = start.saturating_add(len).saturating_sub(eff_start);
    if eff_len == 0 {
      run_idx = run_idx.saturating_add(1);
      continue;
    }

    if let Some(before) = line.get(cursor..eff_start) {
      out.push_str(before);
    }

    let next_idx = run_idx.saturating_add(1);
    let max_later = index.max_after(run_idx);
    let half = eff_len / 2;

    let close_span = if max_later >= eff_len {
      index
        .first_ge(next_idx, eff_len)
        .and_then(|ci| runs.get(ci).map(|&(cs, _)| (cs, eff_len)))
    } else if max_later > half {
      index
        .first_ge(next_idx, max_later)
        .and_then(|ci| runs.get(ci).map(|&(cs, _)| (cs, max_later)))
    } else {
      None
    };

    if let Some((close_start, matched_len)) = close_span {
      out.push(' ');
      cursor = close_start.saturating_add(matched_len);
      run_idx = advance_run_idx(&runs, run_idx, cursor);
      continue;
    }

    if half >= 1 {
      out.push(' ');
      cursor = eff_start.saturating_add(half.saturating_mul(2));
      run_idx = advance_run_idx(&runs, run_idx, cursor);
      continue;
    }

    out.push('`');
    cursor = eff_start.saturating_add(1);
    run_idx = advance_run_idx(&runs, run_idx, cursor);
  }

  if let Some(tail) = line.get(cursor..) {
    out.push_str(tail);
  }
  out
}

fn advance_run_idx(runs: &[(usize, usize)], mut idx: usize, cursor: usize) -> usize {
  while let Some(&(start, len)) = runs.get(idx) {
    if start.saturating_add(len) > cursor {
      break;
    }
    idx = idx.saturating_add(1);
  }
  idx
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn strips_many_inline_code_spans_in_subquadratic_time() {
    let mut line = String::new();
    for i in 0..4_000 {
      line.push_str("`https://example.com/in-code/");
      line.push_str(&i.to_string());
      line.push_str("` ");
    }
    line.push_str("https://example.com/outside");
    let links = extract_links_from_markdown(&line, "https://example.com/");
    assert_eq!(links, vec!["https://example.com/outside"]);
  }
}
