//! Final Markdown cleanup (`tidy`) with arbitrary-length fence tracking and
//! idempotent, panic-free [`post_process_markdown`].

/// Collapse runs of blank lines and trailing spaces while leaving fenced code
/// blocks of any backtick length (>= 3) verbatim.
pub(crate) fn tidy(md: &str) -> String {
  let mut out = String::with_capacity(md.len());
  let mut blank_run = 0usize;
  let mut fence_len: Option<usize> = None;

  for line in md.lines() {
    let trimmed_start = line.trim_start();
    let leading_ticks = trimmed_start.bytes().take_while(|&b| b == b'`').count();
    let after_ticks = trimmed_start.get(leading_ticks..).unwrap_or("");

    match fence_len {
      Some(open_len) => {
        if leading_ticks >= open_len && after_ticks.trim().is_empty() {
          fence_len = None;
        }
        out.push_str(line);
        out.push('\n');
        blank_run = 0;
        continue;
      }
      None => {
        if leading_ticks >= 3 && !after_ticks.contains('`') {
          fence_len = Some(leading_ticks);
          out.push_str(line);
          out.push('\n');
          blank_run = 0;
          continue;
        }
      }
    }

    let trimmed_end = line.trim_end();
    if trimmed_end.is_empty() {
      blank_run = blank_run.saturating_add(1);
      if blank_run > 1 {
        continue;
      }
    } else {
      blank_run = 0;
    }
    out.push_str(trimmed_end);
    out.push('\n');
  }

  out.trim().to_string()
}

/// Strip `[Skip to Content](#...)` anchor links and escape bare newlines inside
/// `[...]` link labels. Backslash-aware and idempotent (`f(f(x)) == f(x)`).
pub fn post_process_markdown(markdown: &str) -> String {
  let stripped = remove_skip_to_content_links(markdown);
  escape_multiline_links(&stripped)
}

fn escape_multiline_links(input: &str) -> String {
  let mut link_open_count = 0usize;
  let mut out = String::with_capacity(input.len());
  let mut chars = input.chars();

  while let Some(ch) = chars.next() {
    if ch == '\\' {
      out.push('\\');
      if let Some(next) = chars.next() {
        out.push(next);
      }
      continue;
    }
    match ch {
      '[' => {
        link_open_count = link_open_count.saturating_add(1);
        out.push('[');
      }
      ']' => {
        link_open_count = link_open_count.saturating_sub(1);
        out.push(']');
      }
      '\n' if link_open_count > 0 => {
        out.push('\\');
        out.push('\n');
      }
      _ => out.push(ch),
    }
  }

  out
}

fn remove_skip_to_content_once(input: &str) -> (String, bool) {
  const LABEL: &str = "Skip to Content";
  let bytes = input.as_bytes();
  let mut out = String::with_capacity(input.len());
  let mut i = 0usize;
  let mut removed = false;

  while let Some(rest) = input.get(i..) {
    if rest.starts_with('[') {
      let label_start = i.saturating_add(1);
      let label_end = label_start.saturating_add(LABEL.len());
      let suffix_end = label_end.saturating_add(3);
      let matches_header = input
        .get(label_start..label_end)
        .is_some_and(|label| label.eq_ignore_ascii_case(LABEL))
        && bytes.get(label_end..suffix_end) == Some(b"](#");

      let rel_close = matches_header
        .then(|| input.get(suffix_end..))
        .flatten()
        .and_then(|after_hash| after_hash.find(')'));
      if let Some(rel_close) = rel_close {
        i = suffix_end.saturating_add(rel_close).saturating_add(1);
        removed = true;
        continue;
      }
    }

    let Some(ch) = rest.chars().next() else {
      break;
    };
    out.push(ch);
    i = i.saturating_add(ch.len_utf8());
  }

  (out, removed)
}

fn remove_skip_to_content_links(input: &str) -> String {
  let mut current = input.to_string();
  loop {
    let (next, removed) = remove_skip_to_content_once(&current);
    if !removed {
      return next;
    }
    current = next;
  }
}
