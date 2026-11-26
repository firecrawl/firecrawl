/// Nominal chunk size in bytes for streaming token fitting.
pub(crate) const CHUNK_BYTES: usize = 65_536;

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

  // Rule 1: ASCII letter followed by space or newline always ends a piece
  // across all OpenAI encodings (o200k, cl100k, p50k, r50k).
  if prev.is_ascii_alphabetic() && matches!(cur, b' ' | b'\n') {
    return true;
  }

  // Rule 2: non-whitespace ASCII (excluding VT 0x0B) + newline + ASCII
  // alphanumeric begins a fresh piece.
  if b >= 2
    && prev == b'\n'
    && cur.is_ascii_alphanumeric()
    && let Some(&prev2) = bytes.get(b.saturating_sub(2))
    && prev2.is_ascii()
    && !prev2.is_ascii_whitespace()
    && prev2 != 0x0B
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

/// Computes the next proven piece-safe chunk end byte offset strictly greater
/// than `start`. Returns `Some(text.len())` when the remaining text fits within
/// `chunk_bytes`, `Some(pos)` at the latest proven piece boundary inside the
/// chunk, or `None` when no proven boundary exists (caller falls back to
/// encoding the unsplit remainder).
pub(crate) fn next_chunk_end(text: &str, start: usize, chunk_bytes: usize) -> Option<usize> {
  let remaining = text.len().saturating_sub(start);
  if remaining <= chunk_bytes {
    return Some(text.len());
  }

  let raw_target = start.saturating_add(chunk_bytes).min(text.len());
  let target = text.floor_char_boundary(raw_target);
  if target >= text.len() {
    return Some(text.len());
  }

  let min_safe = start.saturating_add(1);
  if target < min_safe {
    return None;
  }

  let mut pos = target;
  while pos >= min_safe {
    if is_piece_safe_cut(text, pos) {
      return Some(pos);
    }
    if pos == min_safe {
      break;
    }
    pos = pos.saturating_sub(1);
  }

  None
}
