use std::borrow::Cow;

/// Exact ECMAScript WhiteSpace + LineTerminator set used by `String.prototype.trim()`.
#[inline]
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

#[inline]
pub(crate) fn trim_js_whitespace(s: &str) -> &str {
  s.trim_matches(is_js_whitespace)
}

#[inline]
fn is_valid_host_scalar(c: char) -> bool {
  c.is_ascii_lowercase() || c.is_ascii_digit() || !c.is_ascii()
}

/// Shallow RFC hostname validation matching `tldts-core/src/is-valid.ts`.
pub(crate) fn is_valid_hostname(hostname: &str) -> bool {
  let mut chars = hostname.chars();
  let Some(first) = chars.next() else {
    return false;
  };

  if !(is_valid_host_scalar(first) || first == '.' || first == '_') {
    return false;
  }

  let mut total_utf16: usize = first.len_utf16();
  let mut label_utf16: usize = if first == '.' { 0 } else { total_utf16 };
  let mut prev: char = first;

  for c in chars {
    let unit_len = c.len_utf16();
    total_utf16 = total_utf16.saturating_add(unit_len);
    if total_utf16 > 255 {
      return false;
    }

    if c == '.' {
      if label_utf16 > 63 || prev == '.' || prev == '-' {
        return false;
      }
      label_utf16 = 0;
    } else {
      if !(is_valid_host_scalar(c) || c == '-' || c == '_') {
        return false;
      }
      if c == '-' && prev == '.' {
        return false;
      }
      label_utf16 = label_utf16.saturating_add(unit_len);
    }
    prev = c;
  }

  total_utf16 <= 255 && label_utf16 <= 63 && prev != '-'
}

fn is_probably_ipv4(hostname: &str) -> bool {
  let bytes = hostname.as_bytes();
  if bytes.len() < 7 || bytes.len() > 15 {
    return false;
  }
  if bytes.first() == Some(&b'.') || bytes.last() == Some(&b'.') {
    return false;
  }

  let mut dots: usize = 0;
  for &b in bytes {
    if b == b'.' {
      dots = dots.saturating_add(1);
    } else if !b.is_ascii_digit() {
      return false;
    }
  }
  dots == 3
}

fn is_probably_ipv6(hostname: &str) -> bool {
  let bytes = hostname.as_bytes();
  if bytes.len() < 3 {
    return false;
  }

  let start = usize::from(bytes.first() == Some(&b'['));
  let end = if bytes.last() == Some(&b']') {
    bytes.len().saturating_sub(1)
  } else {
    bytes.len()
  };

  if end.saturating_sub(start) > 39 {
    return false;
  }

  let Some(slice) = bytes.get(start..end) else {
    return false;
  };

  let mut has_colon = false;
  for &b in slice {
    if b == b':' {
      has_colon = true;
    } else if !b.is_ascii_hexdigit() {
      return false;
    }
  }
  has_colon
}

/// Fast IPv4/IPv6 literal detection matching `tldts-core/src/is-ip.ts`.
pub(crate) fn is_ip(hostname: &str) -> bool {
  is_probably_ipv6(hostname) || is_probably_ipv4(hostname)
}

/// Classify scheme `bytes[start..colon_idx]` as a WHATWG special scheme:
/// `0` = not special, `1` = http/https/ws/wss/ftp, `2` = file.
fn get_special_scheme(bytes: &[u8], start: usize, colon_idx: usize) -> u8 {
  let Some(slice) = bytes.get(start..colon_idx) else {
    return 0;
  };
  if slice.eq_ignore_ascii_case(b"http")
    || slice.eq_ignore_ascii_case(b"https")
    || slice.eq_ignore_ascii_case(b"ws")
    || slice.eq_ignore_ascii_case(b"wss")
    || slice.eq_ignore_ascii_case(b"ftp")
  {
    1
  } else if slice.eq_ignore_ascii_case(b"file") {
    2
  } else {
    0
  }
}

fn strip_control_chars(url: &str) -> String {
  url
    .chars()
    .filter(|&c| !matches!(c, '\t' | '\n' | '\r'))
    .collect()
}

/// Extract a hostname from a URL or bare host matching `tldts-core/src/extract-hostname.ts`.
pub(crate) fn extract_hostname<'a>(
  url: &'a str,
  url_is_valid_hostname: bool,
) -> Option<Cow<'a, str>> {
  extract_hostname_inner(url, url_is_valid_hostname, false)
}

fn extract_hostname_inner<'a>(
  url: &'a str,
  url_is_valid_hostname: bool,
  already_stripped: bool,
) -> Option<Cow<'a, str>> {
  let bytes = url.as_bytes();
  let mut start: usize = 0;
  let mut end: usize = bytes.len();
  let mut has_upper = false;
  let mut is_special = false;

  if !url_is_valid_hostname {
    if url.starts_with("data:") {
      return None;
    }

    while start < bytes.len() && bytes.get(start).is_some_and(|&b| b <= 32) {
      start = start.saturating_add(1);
    }
    while end > start.saturating_add(1)
      && bytes.get(end.saturating_sub(1)).is_some_and(|&b| b <= 32)
    {
      end = end.saturating_sub(1);
    }

    if bytes.get(start) == Some(&b'/') && bytes.get(start.saturating_add(1)) == Some(&b'/') {
      start = start.saturating_add(2);
    } else if let Some(rel_idx) = url.get(start..).and_then(|s| s.find(":/")) {
      let proto_idx = start.saturating_add(rel_idx);
      let special = get_special_scheme(bytes, start, proto_idx);
      if special == 1 {
        is_special = true;
        start = proto_idx.saturating_add(2);
        while matches!(bytes.get(start), Some(&b'/' | &b'\\')) {
          start = start.saturating_add(1);
        }
      } else if special == 2 {
        is_special = true;
        start = proto_idx.saturating_add(1);
        let mut slashes: usize = 0;
        while slashes < 2 && matches!(bytes.get(start), Some(&b'/' | &b'\\')) {
          start = start.saturating_add(1);
          slashes = slashes.saturating_add(1);
        }
        if slashes < 2 {
          return None;
        }
      } else {
        for &b in bytes.get(start..proto_idx)? {
          if matches!(b, b'\t' | b'\n' | b'\r') {
            if already_stripped {
              return None;
            }
            let cleaned = strip_control_chars(url);
            return extract_hostname_inner(&cleaned, url_is_valid_hostname, true)
              .map(|cow| Cow::Owned(cow.into_owned()));
          }
          let valid_scheme_byte = b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'+');
          if !valid_scheme_byte {
            return None;
          }
        }
        if bytes.get(proto_idx.saturating_add(2)) == Some(&b'/') {
          start = proto_idx.saturating_add(3);
        } else {
          return None;
        }
      }
    } else if bytes.get(start) != Some(&b'[') {
      let mut index_of_colon: Option<usize> = None;
      for (offset, &b) in bytes.get(start..end)?.iter().enumerate() {
        if matches!(b, b'\t' | b'\n' | b'\r') {
          if already_stripped {
            return None;
          }
          let cleaned = strip_control_chars(url);
          return extract_hostname_inner(&cleaned, url_is_valid_hostname, true)
            .map(|cow| Cow::Owned(cow.into_owned()));
        }
        if b == b':' {
          index_of_colon = Some(start.saturating_add(offset));
          break;
        }
        if matches!(b, b'/' | b'\\' | b'?' | b'#') {
          break;
        }
      }

      if let Some(colon_idx) = index_of_colon {
        let after_colon = bytes.get(colon_idx.saturating_add(1)..end).unwrap_or(&[]);
        let has_identifier = after_colon
          .iter()
          .take_while(|&&b| !matches!(b, b'/' | b'\\' | b'?' | b'#'))
          .any(|&b| b == b'@');

        if !has_identifier {
          let mut digit_count: usize = 0;
          let mut all_digits = true;
          for &b in after_colon {
            if matches!(b, b'/' | b'\\' | b'?' | b'#') {
              break;
            }
            if !b.is_ascii_digit() {
              all_digits = false;
              break;
            }
            digit_count = digit_count.saturating_add(1);
          }
          if digit_count == 0 {
            all_digits = false;
          }

          if !all_digits {
            let special = get_special_scheme(bytes, start, colon_idx);
            if special == 0 {
              let is_bare_ipv6 = after_colon
                .iter()
                .take_while(|&&b| !matches!(b, b'/' | b'\\' | b'?' | b'#'))
                .any(|&b| b == b':');
              if !is_bare_ipv6 {
                return None;
              }
            } else {
              is_special = true;
              start = colon_idx.saturating_add(1);
              if special == 2 {
                let mut slashes: usize = 0;
                while slashes < 2 && matches!(bytes.get(start), Some(&b'/' | &b'\\')) {
                  start = start.saturating_add(1);
                  slashes = slashes.saturating_add(1);
                }
                if slashes < 2 {
                  return None;
                }
              } else {
                while matches!(bytes.get(start), Some(&b'/' | &b'\\')) {
                  start = start.saturating_add(1);
                }
              }
            }
          }
        }
      }
    }

    let mut index_of_identifier: Option<usize> = None;
    let mut index_of_closing_bracket: Option<usize> = None;
    let mut index_of_port: Option<usize> = None;
    let mut index_of_first_colon: Option<usize> = None;
    let mut has_control = false;

    if start < end {
      for (offset, &b) in bytes.get(start..end)?.iter().enumerate() {
        let i = start.saturating_add(offset);
        if matches!(b, b'/' | b'#' | b'?') {
          end = i;
          break;
        } else if b == b':' {
          if index_of_first_colon.is_none() {
            index_of_first_colon = Some(i);
          }
          index_of_port = Some(i);
        } else if matches!(b, b'\t' | b'\n' | b'\r') {
          has_control = true;
        } else if is_special && b == b'\\' {
          end = i;
          break;
        } else if b == b'@' {
          index_of_identifier = Some(i);
          index_of_first_colon = None;
        } else if b == b']' {
          index_of_closing_bracket = Some(i);
        } else if b.is_ascii_uppercase() {
          has_upper = true;
        }
      }
    }

    if has_control {
      if already_stripped {
        return None;
      }
      let cleaned = strip_control_chars(url);
      return extract_hostname_inner(&cleaned, url_is_valid_hostname, true)
        .map(|cow| Cow::Owned(cow.into_owned()));
    }

    if let Some(at_idx) = index_of_identifier
      && at_idx >= start
      && at_idx < end
    {
      start = at_idx.saturating_add(1);
    }

    if bytes.get(start) == Some(&b'[') {
      let close_idx = index_of_closing_bracket?;
      let inner_start = start.saturating_add(1);
      let inner = if close_idx > inner_start {
        url.get(inner_start..close_idx).unwrap_or("")
      } else {
        ""
      };
      return Some(Cow::Owned(inner.to_lowercase()));
    } else if let Some(port_idx) = index_of_port
      && port_idx > start
      && port_idx < end
      && index_of_first_colon == Some(port_idx)
    {
      end = port_idx;
    }

    if start >= end {
      return None;
    }
  }

  while end > start.saturating_add(1) && bytes.get(end.saturating_sub(1)) == Some(&b'.') {
    end = end.saturating_sub(1);
  }

  let hostname = url.get(start..end)?;
  if has_upper {
    Some(Cow::Owned(hostname.to_lowercase()))
  } else {
    Some(Cow::Borrowed(hostname))
  }
}
