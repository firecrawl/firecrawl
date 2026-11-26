use std::borrow::Cow;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AutolinkSegment<'a> {
  Text(&'a str),
  Link { text: &'a str, href: Cow<'a, str> },
}

fn is_url_boundary_before(bytes: &[u8], pos: usize) -> bool {
  if pos == 0 {
    return true;
  }
  let Some(&prev) = bytes.get(pos.saturating_sub(1)) else {
    return true;
  };
  !prev.is_ascii_alphanumeric() && prev != b'_'
}

fn is_email_local_byte(b: u8) -> bool {
  b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'+' | b'-')
}

fn is_email_domain_byte(b: u8) -> bool {
  b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')
}

fn is_email_before_boundary(bytes: &[u8], start: usize) -> bool {
  if start == 0 {
    return true;
  }
  let Some(&prev) = bytes.get(start.saturating_sub(1)) else {
    return true;
  };
  !(prev.is_ascii_alphanumeric()
    || matches!(
      prev,
      b'.'
        | b'!'
        | b'#'
        | b'$'
        | b'%'
        | b'&'
        | b'\''
        | b'*'
        | b'+'
        | b'/'
        | b'='
        | b'?'
        | b'_'
        | b'`'
        | b'{'
        | b'|'
        | b'}'
        | b'~'
        | b'-'
    ))
}

/// Apply `marked`'s GFM `_backpedal` rule to strip trailing punctuation and
/// unmatched closing parens or trailing HTML entity semicolons.
fn backpedal_url(mut url: &str) -> &str {
  loop {
    let prev = url;
    // Strip trailing simple punctuation chars: ? ! . , : ; * _ ' " ~
    let trimmed = url.trim_end_matches(|c: char| {
      matches!(
        c,
        '?' | '!' | '.' | ',' | ':' | ';' | '*' | '_' | '\'' | '"' | '~'
      )
    });
    // Wait: if URL ended in `&entity;`, strip the whole `&entity;` at end.
    if url.ends_with(';')
      && let Some(amp) = url.rfind('&')
      && let Some(mid) = url.get(amp.saturating_add(1)..url.len().saturating_sub(1))
      && !mid.is_empty()
      && mid.bytes().all(|b| b.is_ascii_alphanumeric())
      && let Some(before) = url.get(..amp)
    {
      url = before;
      continue;
    }
    url = trimmed;
    if url.ends_with(')') {
      let opens = url.bytes().filter(|&b| b == b'(').count();
      let closes = url.bytes().filter(|&b| b == b')').count();
      if closes > opens
        && let Some(stripped) = url.strip_suffix(')')
      {
        url = stripped;
      }
    }
    if url == prev {
      break;
    }
  }
  url
}

fn try_match_url_at(input: &str, pos: usize) -> Option<(usize, Cow<'_, str>)> {
  let rest = input.get(pos..)?;
  let lower_prefix_len = rest.len().min(8);
  let prefix = rest.get(..lower_prefix_len)?;

  let (is_www, after_scheme) =
    if prefix.len() >= 8 && prefix.get(..8)?.eq_ignore_ascii_case("https://") {
      (false, 8usize)
    } else if prefix.len() >= 7 && prefix.get(..7)?.eq_ignore_ascii_case("http://") {
      (false, 7usize)
    } else if prefix.len() >= 6 && prefix.get(..6)?.eq_ignore_ascii_case("ftp://") {
      (false, 6usize)
    } else if prefix.len() >= 4 && prefix.get(..4)?.eq_ignore_ascii_case("www.") {
      (true, 4usize)
    } else {
      return None;
    };

  let bytes = rest.as_bytes();
  // Must have at least one domain char `[a-zA-Z0-9-]` right after scheme/www.
  let first_dom = *bytes.get(after_scheme)?;
  if !(first_dom.is_ascii_alphanumeric() || first_dom == b'-') {
    return None;
  }

  let mut end = after_scheme;
  while let Some(&b) = bytes.get(end) {
    if b.is_ascii_whitespace() || b == b'<' {
      break;
    }
    end = end.saturating_add(1);
  }

  let raw_candidate = rest.get(..end)?;
  let cleaned = backpedal_url(raw_candidate);
  if cleaned.len() <= after_scheme {
    return None;
  }

  let href = if is_www {
    Cow::Owned(format!("http://{cleaned}"))
  } else {
    Cow::Borrowed(cleaned)
  };
  Some((pos.saturating_add(cleaned.len()), href))
}

fn try_match_email_at(input: &str, at_pos: usize) -> Option<(usize, usize)> {
  let bytes = input.as_bytes();

  // Scan backwards for local part `[A-Za-z0-9._+-]+`.
  let mut start = at_pos;
  while start > 0 {
    let prev = start.saturating_sub(1);
    if bytes.get(prev).is_some_and(|&b| is_email_local_byte(b)) {
      start = prev;
    } else {
      break;
    }
  }
  if start == at_pos || !is_email_before_boundary(bytes, start) {
    return None;
  }

  // Scan domain: `[a-zA-Z0-9-_]+(\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![-_])`
  let mut idx = at_pos.saturating_add(1);
  let label0_start = idx;
  while bytes.get(idx).is_some_and(|&b| is_email_domain_byte(b)) {
    idx = idx.saturating_add(1);
  }
  if idx == label0_start {
    return None;
  }

  let mut dot_count = 0usize;
  let mut valid_end = idx;
  while bytes.get(idx) == Some(&b'.') {
    let seg_start = idx.saturating_add(1);
    let mut seg_idx = seg_start;
    let mut last_alnum: Option<usize> = None;
    while bytes.get(seg_idx).is_some_and(|&b| is_email_domain_byte(b)) {
      if bytes.get(seg_idx).is_some_and(u8::is_ascii_alphanumeric) {
        last_alnum = Some(seg_idx.saturating_add(1));
      }
      seg_idx = seg_idx.saturating_add(1);
    }
    let Some(end_alnum) = last_alnum else {
      break;
    };
    if seg_idx > end_alnum {
      // Segment ended with '-' or '_', rejected by `(?![-_])`.
      return None;
    }
    dot_count = dot_count.saturating_add(1);
    valid_end = end_alnum;
    idx = seg_idx;
  }

  if dot_count == 0 {
    return None;
  }
  Some((start, valid_end))
}

/// Split plain inline text into text and GFM bare autolink segments (URLs and
/// emails), matching `marked`'s GFM `url` inline rule.
pub(crate) fn split_gfm_autolinks(input: &str) -> Vec<AutolinkSegment<'_>> {
  let has_trigger = input.contains('@')
    || input.contains("://")
    || input.contains("www.")
    || input.contains("WWW.");
  if !has_trigger {
    return vec![AutolinkSegment::Text(input)];
  }

  let bytes = input.as_bytes();
  let mut out = Vec::new();
  let mut text_start = 0usize;
  let mut i = 0usize;

  while let Some(&b) = bytes.get(i) {
    if matches!(b, b'h' | b'H' | b'f' | b'F' | b'w' | b'W')
      && is_url_boundary_before(bytes, i)
      && let Some((end, href)) = try_match_url_at(input, i)
    {
      if i > text_start
        && let Some(t) = input.get(text_start..i)
      {
        out.push(AutolinkSegment::Text(t));
      }
      if let Some(link_text) = input.get(i..end) {
        out.push(AutolinkSegment::Link {
          text: link_text,
          href,
        });
      }
      text_start = end;
      i = end;
      continue;
    }

    if b == b'@'
      && let Some((email_start, email_end)) = try_match_email_at(input, i)
      && email_start >= text_start
    {
      if email_start > text_start
        && let Some(t) = input.get(text_start..email_start)
      {
        out.push(AutolinkSegment::Text(t));
      }
      if let Some(email) = input.get(email_start..email_end) {
        out.push(AutolinkSegment::Link {
          text: email,
          href: Cow::Owned(format!("mailto:{email}")),
        });
      }
      text_start = email_end;
      i = email_end;
      continue;
    }

    i = i.saturating_add(1);
  }

  if text_start < input.len()
    && let Some(tail) = input.get(text_start..)
  {
    out.push(AutolinkSegment::Text(tail));
  }
  out
}
