//! ECMAScript-compatible whitespace and URI percent-decoding helpers.

use std::borrow::Cow;

/// Borrows `s` when it is already ASCII lowercase, allocating only when
/// uppercase ASCII or non-ASCII bytes are present.
pub(crate) fn to_lowercase_cow(s: &str) -> Cow<'_, str> {
  if s.bytes().all(|b| b < 0x80 && !b.is_ascii_uppercase()) {
    Cow::Borrowed(s)
  } else {
    Cow::Owned(s.to_lowercase())
  }
}

/// Matches ECMAScript `WhiteSpace` and `LineTerminator` code points (what JS
/// `String.prototype.trim()` and `/\s/` match).
pub(crate) fn is_js_whitespace(c: char) -> bool {
  matches!(
    c,
    '\u{0009}'..='\u{000D}'
      | '\u{0020}'
      | '\u{00A0}'
      | '\u{1680}'
      | '\u{2000}'..='\u{200A}'
      | '\u{2028}'
      | '\u{2029}'
      | '\u{202F}'
      | '\u{205F}'
      | '\u{3000}'
      | '\u{FEFF}'
  )
}

/// Trims leading and trailing ECMAScript whitespace.
pub(crate) fn js_trim(s: &str) -> &str {
  s.trim_matches(is_js_whitespace)
}

/// Collapses runs of ECMAScript whitespace to a single ASCII space and trims
/// leading/trailing whitespace, matching `.replace(/\s+/g, " ").trim()`.
pub(crate) fn collapse_js_whitespace(s: &str) -> String {
  let mut out = String::with_capacity(s.len());
  let mut in_ws = false;
  for ch in js_trim(s).chars() {
    if is_js_whitespace(ch) {
      if !in_ws {
        out.push(' ');
        in_ws = true;
      }
    } else {
      out.push(ch);
      in_ws = false;
    }
  }
  out
}

/// ECMAScript `decodeURI` equivalent: decodes valid UTF-8 percent-escapes while
/// preserving reserved URI characters (`;/?:@&=+$,#`). Returns `None` on
/// malformed percent-encoding or invalid UTF-8, matching JS `URIError`.
pub(crate) fn decode_uri(s: &str) -> Option<String> {
  decode_percent(s, true)
}

/// ECMAScript `decodeURIComponent` equivalent: decodes all valid UTF-8
/// percent-escapes. Returns `None` on malformed percent-encoding or invalid
/// UTF-8, matching JS `URIError`.
pub(crate) fn decode_uri_component(s: &str) -> Option<String> {
  decode_percent(s, false)
}

fn is_uri_reserved(byte: u8) -> bool {
  matches!(
    byte,
    b';' | b'/' | b'?' | b':' | b'@' | b'&' | b'=' | b'+' | b'$' | b',' | b'#'
  )
}

fn hex_nibble(byte: u8) -> Option<u8> {
  match byte {
    b'0'..=b'9' => byte.checked_sub(b'0'),
    b'a'..=b'f' => byte.checked_sub(b'a').and_then(|v| v.checked_add(10)),
    b'A'..=b'F' => byte.checked_sub(b'A').and_then(|v| v.checked_add(10)),
    _ => None,
  }
}

fn decode_hex_pair(bytes: &[u8], pct_index: usize) -> Option<u8> {
  let hi_idx = pct_index.checked_add(1)?;
  let lo_idx = pct_index.checked_add(2)?;
  let hi = hex_nibble(*bytes.get(hi_idx)?)?;
  let lo = hex_nibble(*bytes.get(lo_idx)?)?;
  hi.checked_mul(16)?.checked_add(lo)
}

fn decode_percent(s: &str, preserve_reserved: bool) -> Option<String> {
  if !s.contains('%') {
    return Some(s.to_string());
  }

  let bytes = s.as_bytes();
  let mut out = Vec::with_capacity(bytes.len());
  let mut i: usize = 0;

  while let Some(&b) = bytes.get(i) {
    if b != b'%' {
      out.push(b);
      i = i.checked_add(1)?;
      continue;
    }

    let first = decode_hex_pair(bytes, i)?;
    if first < 0x80 {
      let end = i.checked_add(3)?;
      if preserve_reserved && is_uri_reserved(first) {
        out.extend_from_slice(bytes.get(i..end)?);
      } else {
        out.push(first);
      }
      i = end;
      continue;
    }

    let seq_len: usize = match first {
      0xC2..=0xDF => 2,
      0xE0..=0xEF => 3,
      0xF0..=0xF4 => 4,
      _ => return None,
    };

    let mut buf = [0u8; 4];
    *buf.get_mut(0)? = first;
    let mut cursor = i.checked_add(3)?;
    for slot in buf.get_mut(1..seq_len)? {
      if *bytes.get(cursor)? != b'%' {
        return None;
      }
      let cont = decode_hex_pair(bytes, cursor)?;
      if !(0x80..=0xBF).contains(&cont) {
        return None;
      }
      *slot = cont;
      cursor = cursor.checked_add(3)?;
    }

    let slice = buf.get(..seq_len)?;
    std::str::from_utf8(slice).ok()?;
    out.extend_from_slice(slice);
    i = cursor;
  }

  String::from_utf8(out).ok()
}
