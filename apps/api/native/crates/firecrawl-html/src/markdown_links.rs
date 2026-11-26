//! Markdown and plaintext link extraction matching
//! `apps/api/src/scraper/scrapeURL/lib/extractLinksFromMarkdown.ts`.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;
use url::Url;

static FENCE_RE: LazyLock<Option<Regex>> =
  LazyLock::new(|| Regex::new(r"^[ \t]{0,3}(`{3,}|~{3,})").ok());
static IMAGE_RE: LazyLock<Option<Regex>> =
  LazyLock::new(|| Regex::new(r"!\[[^\]]*\]\([^)]*\)").ok());
static INLINE_LINK_RE: LazyLock<Option<Regex>> = LazyLock::new(|| {
  Regex::new(r#"\[[^\]]*\]\(\s*(<[^>\n]*>|[^)\s]+)(?:\s+["'][^"']*["'])?\s*\)"#).ok()
});
static REFERENCE_DEF_RE: LazyLock<Option<Regex>> =
  LazyLock::new(|| Regex::new(r"(?m)^[ \t]{0,3}\[[^\]]+\]:[ \t]*(<[^>]+>|\S+)").ok());
static AUTOLINK_RE: LazyLock<Option<Regex>> =
  LazyLock::new(|| Regex::new(r"<((?:https?://|mailto:)[^>\s]+)>").ok());
static BARE_URL_RE: LazyLock<Option<Regex>> =
  LazyLock::new(|| Regex::new(r#"(?:^|[\s(<])(https?://[^\s<>"'`)\]]+)"#).ok());

/// Returns `true` when `content_type` is a plaintext or markdown media type
/// (`text/plain`, `text/markdown`, or `text/x-markdown`).
pub fn is_markdown_content_type(content_type: Option<&str>) -> bool {
  let Some(raw) = content_type else {
    return false;
  };
  let media_type = raw.split(';').next().unwrap_or("").trim();
  media_type.eq_ignore_ascii_case("text/plain")
    || media_type.eq_ignore_ascii_case("text/markdown")
    || media_type.eq_ignore_ascii_case("text/x-markdown")
}

/// Blanks out inline backtick code spans on a single line, matching
/// `/(`+)(?:(?!\1)[^\n])*\1/g` in `extractLinksFromMarkdown.ts`.
fn strip_inline_code_spans(line: &str) -> String {
  let bytes = line.as_bytes();
  let mut out = String::with_capacity(line.len());
  let mut pos = 0usize;

  while pos < bytes.len() {
    let Some(rest) = line.get(pos..) else {
      break;
    };
    let Some(rel_tick) = rest.find('`') else {
      out.push_str(rest);
      break;
    };

    if let Some(before) = rest.get(..rel_tick) {
      out.push_str(before);
    }

    let open_start = pos.saturating_add(rel_tick);
    let tick_len = rest
      .get(rel_tick..)
      .map_or(0, |s| s.bytes().take_while(|&b| b == b'`').count());

    let mut matched = false;
    for len in (1..=tick_len).rev() {
      let after_open = open_start.saturating_add(len);
      let delimiter = "`".repeat(len);
      if let Some(rel_close) = line.get(after_open..).and_then(|s| s.find(&delimiter)) {
        out.push(' ');
        pos = after_open.saturating_add(rel_close).saturating_add(len);
        matched = true;
        break;
      }
    }

    if !matched {
      out.push('`');
      pos = open_start.saturating_add(1);
    }
  }

  out
}

/// Blanks out fenced code blocks and inline code spans.
fn strip_code(text: &str) -> String {
  let mut out = Vec::new();
  let mut fence: Option<(char, usize)> = None;

  for line in text.split('\n') {
    let fence_match = FENCE_RE.as_ref().and_then(|re| re.captures(line));

    if let Some((fence_char, fence_len)) = fence {
      if let Some(cap) = fence_match
        && let (Some(full), Some(run)) = (cap.get(0), cap.get(1))
        && run.as_str().starts_with(fence_char)
        && run.as_str().len() >= fence_len
        && line.get(full.end()..).is_some_and(|s| s.trim().is_empty())
      {
        fence = None;
      }
      out.push(String::new());
      continue;
    }

    if let Some(cap) = fence_match
      && let Some(run) = cap.get(1)
      && let Some(ch) = run.as_str().chars().next()
    {
      fence = Some((ch, run.as_str().len()));
      out.push(String::new());
      continue;
    }

    out.push(strip_inline_code_spans(line));
  }

  out.join("\n")
}

fn resolve_markdown_href(href: &str, base_url: &Url, trim_punctuation: bool) -> Option<String> {
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

  base_url.join(candidate).ok().map(String::from)
}

/// Extracts deduplicated links from a markdown or plaintext body, excluding
/// code blocks, inline code spans, and image destinations.
pub fn extract_links_from_markdown(text: &str, base_url: &Url) -> Vec<String> {
  let stripped = strip_code(text);
  let body = match IMAGE_RE.as_ref() {
    Some(re) => re.replace_all(&stripped, " "),
    None => std::borrow::Cow::Borrowed(stripped.as_str()),
  };

  let mut seen = HashSet::new();
  let mut links = Vec::new();
  let mut push = |href: &str, trim_punctuation: bool| {
    if let Some(resolved) = resolve_markdown_href(href, base_url, trim_punctuation)
      && seen.insert(resolved.clone())
    {
      links.push(resolved);
    }
  };

  if let Some(re) = INLINE_LINK_RE.as_ref() {
    for cap in re.captures_iter(&body) {
      if let Some(m) = cap.get(1) {
        push(m.as_str(), false);
      }
    }
  }
  if let Some(re) = REFERENCE_DEF_RE.as_ref() {
    for cap in re.captures_iter(&body) {
      if let Some(m) = cap.get(1) {
        push(m.as_str(), false);
      }
    }
  }
  if let Some(re) = AUTOLINK_RE.as_ref() {
    for cap in re.captures_iter(&body) {
      if let Some(m) = cap.get(1) {
        push(m.as_str(), false);
      }
    }
  }
  if let Some(re) = BARE_URL_RE.as_ref() {
    for cap in re.captures_iter(&body) {
      if let Some(m) = cap.get(1) {
        push(m.as_str(), true);
      }
    }
  }

  links
}
