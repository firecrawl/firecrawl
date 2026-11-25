//! Final Markdown cleanup (`tidy`) with arbitrary-length backtick/tilde fence
//! tracking and linear-time, idempotent [`post_process_markdown`].

/// Advance fenced-code state for `line` (without trailing newline) and return
/// `true` if the line opens, continues, or closes a fenced code block.
fn update_fence_state(line: &str, fence: &mut Option<(u8, usize)>) -> bool {
  let trimmed_start = line.trim_start();
  let first = trimmed_start.as_bytes().first().copied();

  if let Some((marker, open_len)) = *fence {
    if first == Some(marker) {
      let run = trimmed_start.bytes().take_while(|&b| b == marker).count();
      let after = trimmed_start.get(run..).unwrap_or("");
      if run >= open_len && after.trim().is_empty() {
        *fence = None;
      }
    }
    return true;
  }

  if let Some(marker @ (b'`' | b'~')) = first {
    let run = trimmed_start.bytes().take_while(|&b| b == marker).count();
    let after = trimmed_start.get(run..).unwrap_or("");
    if run >= 3 && (marker == b'~' || !after.contains('`')) {
      *fence = Some((marker, run));
      return true;
    }
  }

  false
}

/// Collapse runs of blank lines and trailing spaces while leaving backtick and
/// tilde fenced code blocks of any length (>= 3) verbatim.
pub(crate) fn tidy(md: &str) -> String {
  let mut out = String::with_capacity(md.len());
  let mut blank_run = 0usize;
  let mut fence: Option<(u8, usize)> = None;

  for line in md.lines() {
    if update_fence_state(line, &mut fence) {
      out.push_str(line);
      out.push('\n');
      blank_run = 0;
      continue;
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
/// matched `[...]` link labels outside fenced code blocks. Linear-time and
/// idempotent (`f(f(x)) == f(x)`).
pub fn post_process_markdown(markdown: &str) -> String {
  let stripped = remove_skip_to_content_links(markdown);
  escape_multiline_links(&stripped)
}

/// Mark byte offsets of `[` and `]` outside fenced code blocks that form
/// balanced pairs, leaving unmatched brackets untouched.
fn find_matched_brackets(input: &str) -> Vec<bool> {
  let mut matched = vec![false; input.len()];
  let mut open_stack: Vec<usize> = Vec::new();
  let mut fence: Option<(u8, usize)> = None;
  let mut line_start = 0usize;

  for raw_line in input.split_inclusive('\n') {
    let content = raw_line
      .strip_suffix('\n')
      .unwrap_or(raw_line)
      .strip_suffix('\r')
      .unwrap_or_else(|| raw_line.strip_suffix('\n').unwrap_or(raw_line));
    if !update_fence_state(content, &mut fence) {
      let mut iter = raw_line.char_indices();
      while let Some((rel, ch)) = iter.next() {
        if ch == '\\' {
          let _ = iter.next();
          continue;
        }
        let abs = line_start.saturating_add(rel);
        match ch {
          '[' => open_stack.push(abs),
          ']' => {
            if let Some(open_pos) = open_stack.pop() {
              if let Some(slot) = matched.get_mut(open_pos) {
                *slot = true;
              }
              if let Some(slot) = matched.get_mut(abs) {
                *slot = true;
              }
            }
          }
          _ => {}
        }
      }
    }
    line_start = line_start.saturating_add(raw_line.len());
  }

  matched
}

fn escape_multiline_links(input: &str) -> String {
  if !input.contains('[') || !input.contains('\n') {
    return input.to_string();
  }

  let matched = find_matched_brackets(input);
  let mut link_open_count = 0usize;
  let mut fence: Option<(u8, usize)> = None;
  let mut out = String::with_capacity(input.len());
  let mut line_start = 0usize;

  for raw_line in input.split_inclusive('\n') {
    let content = raw_line
      .strip_suffix('\n')
      .unwrap_or(raw_line)
      .strip_suffix('\r')
      .unwrap_or_else(|| raw_line.strip_suffix('\n').unwrap_or(raw_line));
    if update_fence_state(content, &mut fence) {
      out.push_str(raw_line);
    } else {
      let mut iter = raw_line.char_indices();
      while let Some((rel, ch)) = iter.next() {
        if ch == '\\' {
          out.push('\\');
          if let Some((_, next)) = iter.next() {
            out.push(next);
          }
          continue;
        }
        let abs = line_start.saturating_add(rel);
        match ch {
          '[' if matched.get(abs).copied().unwrap_or(false) => {
            link_open_count = link_open_count.saturating_add(1);
            out.push('[');
          }
          ']' if matched.get(abs).copied().unwrap_or(false) => {
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
    }
    line_start = line_start.saturating_add(raw_line.len());
  }

  out
}

/// Single-pass O(n) removal of `[Skip to Content](#...)` anchor links,
/// including nested occurrences revealed by removing an inner link.
fn remove_skip_to_content_links(input: &str) -> String {
  const PREFIX: &[u8] = b"[Skip to Content](#";
  let mut out = String::with_capacity(input.len());
  let mut open_skips: Vec<usize> = Vec::new();

  for ch in input.chars() {
    out.push(ch);
    match ch {
      '#' => {
        let matched = out.len().checked_sub(PREFIX.len()).filter(|&start| {
          out
            .as_bytes()
            .get(start..)
            .is_some_and(|tail| tail.eq_ignore_ascii_case(PREFIX))
        });
        if let Some(start) = matched {
          open_skips.push(start);
        }
      }
      ')' => {
        if let Some(start) = open_skips.pop() {
          out.truncate(start);
        }
      }
      _ => {}
    }
  }

  out
}
