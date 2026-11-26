//! Line lexing, encoding normalization, and RFC 9309 pattern matching helpers
//! for `robots.rs`.

use url::Url;

const HEX_UPPER: [u8; 16] = *b"0123456789ABCDEF";

#[derive(Debug, Clone)]
pub(crate) struct Rule {
  pub(crate) pattern: String,
  pub(crate) allow: bool,
  pub(crate) line_number: usize,
}

pub(crate) fn split_lines(input: &str) -> impl Iterator<Item = &str> {
  struct LineIter<'a> {
    rest: &'a str,
    done: bool,
  }

  impl<'a> Iterator for LineIter<'a> {
    type Item = &'a str;

    fn next(&mut self) -> Option<Self::Item> {
      if self.done {
        return None;
      }
      let bytes = self.rest.as_bytes();
      let mut i = 0usize;
      while let Some(&b) = bytes.get(i) {
        if b == b'\r' {
          let line = self.rest.get(..i).unwrap_or("");
          let next_idx = if bytes.get(i.saturating_add(1)) == Some(&b'\n') {
            i.saturating_add(2)
          } else {
            i.saturating_add(1)
          };
          self.rest = self.rest.get(next_idx..).unwrap_or("");
          return Some(line);
        }
        if b == b'\n' {
          let line = self.rest.get(..i).unwrap_or("");
          self.rest = self.rest.get(i.saturating_add(1)..).unwrap_or("");
          return Some(line);
        }
        i = i.saturating_add(1);
      }
      self.done = true;
      Some(self.rest)
    }
  }

  LineIter {
    rest: input,
    done: false,
  }
}

pub(crate) fn trim_robots(s: &str) -> &str {
  s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

pub(crate) fn strip_comment(line: &str) -> &str {
  match line.find('#') {
    Some(idx) => line.get(..idx).unwrap_or(line),
    None => line,
  }
}

pub(crate) fn split_directive(line: &str) -> Option<(&str, &str)> {
  if line.is_empty() {
    return None;
  }
  let idx = line.find(':')?;
  let key = line.get(..idx)?;
  let val = line.get(idx.saturating_add(1)..)?;
  Some((key, val))
}

pub(crate) fn format_user_agent(user_agent: &str) -> String {
  let lower = user_agent.to_lowercase();
  let without_version = match lower.find('/') {
    Some(idx) => lower.get(..idx).unwrap_or(&lower),
    None => &lower,
  };
  trim_robots(without_version).to_string()
}

pub(crate) fn parse_js_number(raw: &str) -> Option<f64> {
  if raw.is_empty() {
    return Some(0.0);
  }
  match raw {
    "Infinity" | "+Infinity" => return Some(f64::INFINITY),
    "-Infinity" => return Some(f64::NEG_INFINITY),
    _ => {}
  }

  if let Some(hex) = raw.strip_prefix("0x").or_else(|| raw.strip_prefix("0X")) {
    return parse_radix_f64(hex, 16);
  }
  if let Some(oct) = raw.strip_prefix("0o").or_else(|| raw.strip_prefix("0O")) {
    return parse_radix_f64(oct, 8);
  }
  if let Some(bin) = raw.strip_prefix("0b").or_else(|| raw.strip_prefix("0B")) {
    return parse_radix_f64(bin, 2);
  }

  let valid_chars = raw
    .bytes()
    .all(|b| b.is_ascii_digit() || matches!(b, b'+' | b'-' | b'.' | b'e' | b'E'));
  if !valid_chars {
    return None;
  }

  raw.parse::<f64>().ok().filter(|v| !v.is_nan())
}

fn parse_radix_f64(digits: &str, radix: u32) -> Option<f64> {
  if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
    return None;
  }
  let base = f64::from(radix);
  let mut acc = 0.0f64;
  for c in digits.chars() {
    let digit = c.to_digit(radix)?;
    acc = acc.mul_add(base, f64::from(digit));
  }
  Some(acc)
}

pub(crate) fn extract_path_and_query(url: &Url) -> String {
  let mut path = url.path().to_string();
  if let Some(query) = url.query() {
    path.push('?');
    path.push_str(query);
  }
  normalize_percent_escapes(&path)
}

fn is_encode_uri_passthrough(b: u8) -> bool {
  b.is_ascii_alphanumeric()
    || matches!(
      b,
      b';'
        | b','
        | b'/'
        | b'?'
        | b':'
        | b'@'
        | b'&'
        | b'='
        | b'+'
        | b'$'
        | b'-'
        | b'_'
        | b'.'
        | b'!'
        | b'~'
        | b'*'
        | b'\''
        | b'('
        | b')'
        | b'#'
        | b'%'
    )
}

pub(crate) fn normalize_encoding(path: &str) -> String {
  let mut encoded = String::with_capacity(path.len());
  for &b in path.as_bytes() {
    if is_encode_uri_passthrough(b) {
      encoded.push(char::from(b));
    } else {
      encoded.push('%');
      let hi = usize::from(b >> 4);
      let lo = usize::from(b & 0x0f);
      if let (Some(&h), Some(&l)) = (HEX_UPPER.get(hi), HEX_UPPER.get(lo)) {
        encoded.push(char::from(h));
        encoded.push(char::from(l));
      }
    }
  }
  normalize_percent_escapes(&encoded)
}

fn hex_value(b: u8) -> Option<u8> {
  match b {
    b'0'..=b'9' => Some(b.saturating_sub(b'0')),
    b'a'..=b'f' => Some(b.saturating_sub(b'a').saturating_add(10)),
    b'A'..=b'F' => Some(b.saturating_sub(b'A').saturating_add(10)),
    _ => None,
  }
}

fn is_rfc3986_unreserved(b: u8) -> bool {
  b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~')
}

fn normalize_percent_escapes(path: &str) -> String {
  let bytes = path.as_bytes();
  let mut out = Vec::with_capacity(bytes.len());
  let mut i = 0usize;
  while let Some(&b) = bytes.get(i) {
    match (
      b,
      bytes.get(i.saturating_add(1)).and_then(|&h| hex_value(h)),
      bytes.get(i.saturating_add(2)).and_then(|&h| hex_value(h)),
    ) {
      (b'%', Some(hi), Some(lo)) => {
        let decoded = (hi << 4) | lo;
        if is_rfc3986_unreserved(decoded) {
          out.push(decoded);
        } else {
          out.push(b'%');
          if let (Some(&h), Some(&l)) = (
            HEX_UPPER.get(usize::from(hi)),
            HEX_UPPER.get(usize::from(lo)),
          ) {
            out.push(h);
            out.push(l);
          }
        }
        i = i.saturating_add(3);
      }
      _ => {
        out.push(b);
        i = i.saturating_add(1);
      }
    }
  }
  String::from_utf8(out).unwrap_or_else(|_| path.to_string())
}

pub(crate) fn find_rule<'a>(path: &str, rules: &'a [Rule]) -> Option<&'a Rule> {
  let mut matched: Option<&'a Rule> = None;
  for rule in rules {
    if !matches_pattern(&rule.pattern, path) {
      continue;
    }
    match matched {
      None => matched = Some(rule),
      Some(prev) if rule.pattern.len() > prev.pattern.len() => matched = Some(rule),
      Some(prev) if rule.pattern.len() == prev.pattern.len() && rule.allow && !prev.allow => {
        matched = Some(rule);
      }
      Some(_) => {}
    }
  }
  matched
}

fn matches_pattern(pattern: &str, path: &str) -> bool {
  let pat = pattern.as_bytes();
  let txt = path.as_bytes();
  let mut matching_lengths: Vec<usize> = Vec::with_capacity(txt.len().saturating_add(1));
  matching_lengths.push(0);

  let mut p = 0usize;
  while let Some(&ch) = pat.get(p) {
    let next_p = p.saturating_add(1);
    if ch == b'$' && next_p == pat.len() {
      return matching_lengths.last().copied() == Some(txt.len());
    }
    if ch == b'*' {
      let mut skip = next_p;
      while pat.get(skip) == Some(&b'*') {
        skip = skip.saturating_add(1);
      }
      p = skip;
      let Some(&min_len) = matching_lengths.first() else {
        return false;
      };
      matching_lengths.clear();
      for len in min_len..=txt.len() {
        matching_lengths.push(len);
      }
    } else {
      let mut write = 0usize;
      for read in 0..matching_lengths.len() {
        let Some(&pos) = matching_lengths.get(read) else {
          break;
        };
        if txt.get(pos) == Some(&ch) {
          if let Some(slot) = matching_lengths.get_mut(write) {
            *slot = pos.saturating_add(1);
          }
          write = write.saturating_add(1);
        }
      }
      if write == 0 {
        return false;
      }
      matching_lengths.truncate(write);
      p = next_p;
    }
  }

  true
}
