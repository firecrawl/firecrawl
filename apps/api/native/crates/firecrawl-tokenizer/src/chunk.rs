use crate::models::{Encoding, MAX_SPECIAL_TOKEN_BYTES};

/// Nominal chunk size in bytes for streaming token fitting.
pub(crate) const CHUNK_BYTES: usize = 65_536;

/// How far back from `target` to search for a pretokenizer piece boundary.
const MAX_SCAN_BACK: usize = 8_192;

/// Returns whether cutting `text` at byte offset `b` is guaranteed not to split
/// a pretokenizer piece across any OpenAI encoding (o200k, cl100k, p50k, r50k).
fn is_piece_safe_cut(text: &str, b: usize) -> bool {
  let bytes = text.as_bytes();
  if b == 0 || b >= bytes.len() || !text.is_char_boundary(b) {
    return false;
  }

  let Some(&prev) = bytes.get(b.saturating_sub(1)) else {
    return false;
  };
  let Some(&cur) = bytes.get(b) else {
    return false;
  };

  // Rule 1: ASCII letter or digit followed by space or newline always ends a piece
  // across all OpenAI encodings (o200k, cl100k, p50k, r50k).
  if prev.is_ascii_alphanumeric() && matches!(cur, b' ' | b'\n') {
    return true;
  }

  // Rule 2: non-whitespace ASCII + newline + ASCII alphanumeric begins a fresh piece.
  if b >= 2
    && prev == b'\n'
    && cur.is_ascii_alphanumeric()
    && let Some(&prev2) = bytes.get(b.saturating_sub(2))
    && prev2.is_ascii()
    && !prev2.is_ascii_whitespace()
  {
    return true;
  }

  // Rule 3: Han character (U+4E00..=U+9FA5) followed by CJK punctuation.
  if b >= 3
    && let Some(prev_slice) = text.get(b.saturating_sub(3)..b)
    && let Some(prev_ch) = prev_slice.chars().next()
    && ('\u{4E00}'..='\u{9FA5}').contains(&prev_ch)
    && let Some(next_slice) = text.get(b..)
    && let Some(next_ch) = next_slice.chars().next()
    && matches!(next_ch, '，' | '。' | '、' | '！' | '？' | '；' | '：')
  {
    return true;
  }

  false
}

/// Computes the next chunk end byte offset strictly greater than `start`.
pub(crate) fn next_chunk_end(text: &str, start: usize, chunk_bytes: usize) -> usize {
  let remaining = text.len().saturating_sub(start);
  if remaining <= chunk_bytes {
    return text.len();
  }

  let raw_target = start.saturating_add(chunk_bytes).min(text.len());
  let mut target = text.floor_char_boundary(raw_target);
  if target <= start {
    target = text.ceil_char_boundary(start.saturating_add(1).min(text.len()));
  }
  if target >= text.len() {
    return text.len();
  }

  let min_safe = start
    .saturating_add(1)
    .max(target.saturating_sub(MAX_SCAN_BACK));
  let mut pos = target;
  while pos >= min_safe {
    if is_piece_safe_cut(text, pos) {
      return pos;
    }
    if pos == min_safe {
      break;
    }
    pos = pos.saturating_sub(1);
  }

  // Fall back to the last newline within the chunk, else the UTF-8 char boundary.
  if let Some(chunk) = text.get(start..target)
    && let Some(rel_nl) = chunk.rfind('\n')
  {
    let after_nl = start.saturating_add(rel_nl).saturating_add(1);
    if after_nl > start && after_nl <= target {
      return after_nl;
    }
  }

  target
}

/// Checks whether any disallowed special token overlaps byte range `start..end`,
/// including tokens that straddle either boundary of the chunk.
pub(crate) fn find_disallowed_special_in_chunk(
  encoding: Encoding,
  text: &str,
  start: usize,
  end: usize,
) -> Option<&'static str> {
  let overlap = MAX_SPECIAL_TOKEN_BYTES.saturating_sub(1);
  let win_start = text.floor_char_boundary(start.saturating_sub(overlap));
  let win_end = text.ceil_char_boundary(end.saturating_add(overlap).min(text.len()));
  let window = text.get(win_start..win_end)?;
  if !window.contains("<|") {
    return None;
  }

  let mut earliest: Option<(usize, &'static str)> = None;
  for &token in encoding.disallowed_special_tokens() {
    for (rel_pos, _) in window.match_indices(token) {
      let abs_start = win_start.saturating_add(rel_pos);
      let abs_end = abs_start.saturating_add(token.len());
      if abs_end > start && abs_start < end {
        let is_earlier = match earliest {
          None => true,
          Some((best_pos, _)) => abs_start < best_pos,
        };
        if is_earlier {
          earliest = Some((abs_start, token));
        }
        break;
      }
    }
  }
  earliest.map(|(_, token)| token)
}
