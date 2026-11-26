//! Pure-Rust markdown link extractor (excluding images and code spans/blocks).

use std::{collections::HashSet, sync::LazyLock};

use regex::Regex;
use url::Url;

static IMAGE: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"!\[[^\]]*\]\([^)]*\)").ok());
static INLINE_LINK: LazyLock<Option<Regex>> = LazyLock::new(|| {
  Regex::new(r#"\[[^\]]*\]\(\s*(<[^>\n]*>|[^)\s]+)(?:\s+["'][^"']*["'])?\s*\)"#).ok()
});
static REFERENCE_DEFINITION: LazyLock<Option<Regex>> =
  LazyLock::new(|| Regex::new(r"(?m)^[ \t]{0,3}\[[^\]]+\]:[ \t]*(<[^>]+>|\S+)").ok());
static AUTOLINK: LazyLock<Option<Regex>> =
  LazyLock::new(|| Regex::new(r"<((?:https?://|mailto:)[^>\s]+)>").ok());
static BARE_URL: LazyLock<Option<Regex>> =
  LazyLock::new(|| Regex::new(r#"(?:^|[\s(<])(https?://[^\s<>"'`)\]]+)"#).ok());

/// Extracts deduplicated resolved links from a markdown or plaintext body,
/// excluding images, fenced code blocks, and inline code spans.
#[must_use]
pub fn extract_links_from_markdown(text: &str, base_url: &str) -> Vec<String> {
  let stripped = strip_code(text);
  let body = match IMAGE.as_ref() {
    Some(re) => re.replace_all(&stripped, " "),
    None => std::borrow::Cow::Borrowed(stripped.as_str()),
  };

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

  if let Some(re) = INLINE_LINK.as_ref() {
    for cap in re.captures_iter(&body) {
      if let Some(m) = cap.get(1) {
        push(m.as_str(), false);
      }
    }
  }
  if let Some(re) = REFERENCE_DEFINITION.as_ref() {
    for cap in re.captures_iter(&body) {
      if let Some(m) = cap.get(1) {
        push(m.as_str(), false);
      }
    }
  }
  if let Some(re) = AUTOLINK.as_ref() {
    for cap in re.captures_iter(&body) {
      if let Some(m) = cap.get(1) {
        push(m.as_str(), false);
      }
    }
  }
  if let Some(re) = BARE_URL.as_ref() {
    for cap in re.captures_iter(&body) {
      if let Some(m) = cap.get(1) {
        push(m.as_str(), true);
      }
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

/// Linear-time replacement equivalent to JS `line.replace(/(`+)(?:(?!\1)[^\n])*\1/g, " ")`.
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

    let later_runs = runs.get(run_idx.saturating_add(1)..).unwrap_or(&[]);
    let max_later = later_runs.iter().map(|&(_, l)| l).max().unwrap_or(0);
    let half = eff_len / 2;

    if max_later >= eff_len {
      if let Some(&(close_start, _)) = later_runs.iter().find(|&&(_, l)| l >= eff_len) {
        out.push(' ');
        cursor = close_start.saturating_add(eff_len);
        run_idx = advance_run_idx(&runs, run_idx, cursor);
        continue;
      }
    } else if max_later > half {
      if let Some(&(close_start, _)) = later_runs.iter().find(|&&(_, l)| l >= max_later) {
        out.push(' ');
        cursor = close_start.saturating_add(max_later);
        run_idx = advance_run_idx(&runs, run_idx, cursor);
        continue;
      }
    } else if half >= 1 {
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
