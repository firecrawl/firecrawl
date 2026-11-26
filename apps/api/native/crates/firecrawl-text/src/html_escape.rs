use std::borrow::Cow;

/// Escape `&`, `<`, `>`, `"`, `'` identically to `marked`'s `escape(text, true)`.
pub(crate) fn marked_escape_encode(input: &str) -> Cow<'_, str> {
  if !input
    .bytes()
    .any(|b| matches!(b, b'&' | b'<' | b'>' | b'"' | b'\''))
  {
    return Cow::Borrowed(input);
  }
  let mut out = String::with_capacity(input.len());
  for ch in input.chars() {
    match ch {
      '&' => out.push_str("&amp;"),
      '<' => out.push_str("&lt;"),
      '>' => out.push_str("&gt;"),
      '"' => out.push_str("&quot;"),
      '\'' => out.push_str("&#39;"),
      other => out.push(other),
    }
  }
  Cow::Owned(out)
}

fn is_marked_entity_at(bytes: &[u8], amp_pos: usize) -> bool {
  let start = amp_pos.saturating_add(1);
  let Some(&first) = bytes.get(start) else {
    return false;
  };
  if first == b'#' {
    let next = start.saturating_add(1);
    let Some(&second) = bytes.get(next) else {
      return false;
    };
    if second == b'x' || second == b'X' {
      let mut idx = next.saturating_add(1);
      let mut len = 0usize;
      while let Some(&b) = bytes.get(idx) {
        if b.is_ascii_hexdigit() && len < 6 {
          idx = idx.saturating_add(1);
          len = len.saturating_add(1);
        } else {
          break;
        }
      }
      return len >= 1 && bytes.get(idx) == Some(&b';');
    }
    let mut idx = next;
    let mut len = 0usize;
    while let Some(&b) = bytes.get(idx) {
      if b.is_ascii_digit() && len < 7 {
        idx = idx.saturating_add(1);
        len = len.saturating_add(1);
      } else {
        break;
      }
    }
    return len >= 1 && bytes.get(idx) == Some(&b';');
  }

  let mut idx = start;
  while let Some(&b) = bytes.get(idx) {
    if b.is_ascii_alphanumeric() || b == b'_' {
      idx = idx.saturating_add(1);
    } else {
      break;
    }
  }
  idx > start && bytes.get(idx) == Some(&b';')
}

/// Escape `<`, `>`, `"`, `'`, and `&` not already starting an entity, matching
/// `marked`'s `escape(text, false)`.
pub(crate) fn marked_escape_no_encode(input: &str) -> Cow<'_, str> {
  if !input
    .bytes()
    .any(|b| matches!(b, b'&' | b'<' | b'>' | b'"' | b'\''))
  {
    return Cow::Borrowed(input);
  }
  let bytes = input.as_bytes();
  let mut out = String::with_capacity(input.len());
  let mut last = 0usize;

  for (idx, b) in bytes.iter().copied().enumerate() {
    let replacement = match b {
      b'<' => Some("&lt;"),
      b'>' => Some("&gt;"),
      b'"' => Some("&quot;"),
      b'\'' => Some("&#39;"),
      b'&' if !is_marked_entity_at(bytes, idx) => Some("&amp;"),
      _ => None,
    };
    if let Some(rep) = replacement {
      if let Some(chunk) = input.get(last..idx) {
        out.push_str(chunk);
      }
      out.push_str(rep);
      last = idx.saturating_add(1);
    }
  }

  if last == 0 {
    return Cow::Borrowed(input);
  }
  if let Some(tail) = input.get(last..) {
    out.push_str(tail);
  }
  Cow::Owned(out)
}
