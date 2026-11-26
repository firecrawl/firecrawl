//! Iterative namespace-lenient XML parser for real-world sitemaps that omit
//! `xmlns:` declarations, duplicate attributes, or use HTML4 named entities.

use crate::sitemap::{
  MAX_SITEMAP_DEPTH, ParseOutcome, ParsedSitemap, SitemapEntry, SitemapIndex, SitemapUrl,
  SitemapUrlset,
};
use crate::sitemap_entities::lookup_named_entity;
use crate::xml::doctype_end;

#[derive(Clone, Copy, PartialEq, Eq)]
enum RootKind {
  Urlset,
  SitemapIndex,
}

pub(crate) fn parse_sitemap_lenient(xml: &str) -> Result<ParsedSitemap, ParseOutcome> {
  let mut stack: Vec<String> = Vec::new();
  let mut root_kind: Option<RootKind> = None;
  let mut root_closed = false;
  let mut in_entry = false;
  let mut entry_has_loc = false;
  let mut loc_buf: Option<String> = None;
  let mut loc_has_text = false;
  let mut urls: Vec<SitemapUrl> = Vec::new();
  let mut sitemaps: Vec<SitemapEntry> = Vec::new();

  let mut i = 0usize;
  while let Some(rest) = xml.get(i..) {
    if rest.is_empty() {
      break;
    }

    if let Some(after_lt) = rest.strip_prefix('<') {
      if let Some(after_comment) = after_lt.strip_prefix("!--") {
        let Some(end) = after_comment.find("-->") else {
          return Err(ParseOutcome::XmlError("unterminated comment".to_string()));
        };
        i = i.saturating_add(4).saturating_add(end).saturating_add(3);
        continue;
      }

      if let Some(after_cdata) = after_lt.strip_prefix("![CDATA[") {
        let Some(end) = after_cdata.find("]]>") else {
          return Err(ParseOutcome::XmlError("unterminated CDATA".to_string()));
        };
        if let (true, Some(buf), Some(content)) =
          (stack.len() == 3, loc_buf.as_mut(), after_cdata.get(..end))
        {
          buf.push_str(content);
          loc_has_text = true;
        }
        i = i.saturating_add(9).saturating_add(end).saturating_add(3);
        continue;
      }

      if let Some(after_pi) = after_lt.strip_prefix('?') {
        let Some(end) = after_pi.find("?>") else {
          return Err(ParseOutcome::XmlError(
            "unterminated processing instruction".to_string(),
          ));
        };
        i = i.saturating_add(2).saturating_add(end).saturating_add(2);
        continue;
      }

      if rest.starts_with("<!DOCTYPE") {
        let Some(end) = doctype_end(rest) else {
          return Err(ParseOutcome::XmlError("unterminated DOCTYPE".to_string()));
        };
        i = i.saturating_add(end).saturating_add(1);
        continue;
      }

      if let Some(after_close) = after_lt.strip_prefix('/') {
        let Some(gt) = after_close.find('>') else {
          return Err(ParseOutcome::XmlError(
            "unterminated closing tag".to_string(),
          ));
        };
        let raw_name = after_close.get(..gt).unwrap_or("").trim();
        if !is_valid_xml_name(raw_name) {
          return Err(ParseOutcome::XmlError(
            "invalid closing tag name".to_string(),
          ));
        }
        let Some(open_name) = stack.pop() else {
          return Err(ParseOutcome::XmlError("unexpected closing tag".to_string()));
        };
        if open_name != raw_name {
          return Err(ParseOutcome::XmlError("mismatched closing tag".to_string()));
        }

        let finished_loc = if stack.len() == 2 {
          loc_buf.take()
        } else {
          None
        };
        if let Some(text) = finished_loc {
          if loc_has_text {
            match root_kind {
              Some(RootKind::Urlset) => urls.push(SitemapUrl { loc: vec![text] }),
              Some(RootKind::SitemapIndex) => sitemaps.push(SitemapEntry { loc: vec![text] }),
              None => {}
            }
          }
          loc_has_text = false;
        }
        if stack.len() == 1 {
          in_entry = false;
          entry_has_loc = false;
        }
        if stack.is_empty() {
          root_closed = true;
        }

        i = i.saturating_add(2).saturating_add(gt).saturating_add(1);
        continue;
      }

      if root_closed {
        return Err(ParseOutcome::XmlError("multiple root elements".to_string()));
      }

      let (tag_name, self_closing, consumed) = parse_open_tag(rest)?;
      let local = local_name(tag_name);

      if stack.is_empty() {
        root_kind = match local {
          "urlset" => Some(RootKind::Urlset),
          "sitemapindex" => Some(RootKind::SitemapIndex),
          _ => return Err(ParseOutcome::InvalidRoot),
        };
        if self_closing {
          root_closed = true;
        }
      }

      if !self_closing {
        if stack.len() >= MAX_SITEMAP_DEPTH {
          return Err(ParseOutcome::XmlError(format!(
            "elements nested deeper than {MAX_SITEMAP_DEPTH} levels"
          )));
        }
        if stack.len() == 1 {
          in_entry = matches!(
            (root_kind, local),
            (Some(RootKind::Urlset), "url") | (Some(RootKind::SitemapIndex), "sitemap")
          );
          entry_has_loc = false;
        } else if stack.len() == 2 && in_entry && !entry_has_loc && local == "loc" {
          entry_has_loc = true;
          loc_buf = Some(String::new());
          loc_has_text = false;
        }
        stack.push(tag_name.to_string());
      }

      i = i.saturating_add(consumed);
    } else {
      let next_lt = rest.find('<').unwrap_or(rest.len());
      let chunk = rest.get(..next_lt).unwrap_or("");
      if stack.is_empty() {
        if !chunk.trim().is_empty() {
          return Err(ParseOutcome::XmlError(
            "unexpected text outside root element".to_string(),
          ));
        }
      } else {
        let decoded = decode_xml_entities(chunk)?;
        if let (true, Some(buf)) = (stack.len() == 3, loc_buf.as_mut()) {
          buf.push_str(&decoded);
          loc_has_text = true;
        }
      }
      i = i.saturating_add(next_lt);
    }
  }

  if !stack.is_empty() || !root_closed {
    return Err(ParseOutcome::XmlError("unclosed XML element".to_string()));
  }

  match root_kind {
    Some(RootKind::Urlset) => Ok(ParsedSitemap {
      urlset: Some(SitemapUrlset { url: urls }),
      sitemapindex: None,
    }),
    Some(RootKind::SitemapIndex) => Ok(ParsedSitemap {
      urlset: None,
      sitemapindex: Some(SitemapIndex { sitemap: sitemaps }),
    }),
    None => Err(ParseOutcome::InvalidRoot),
  }
}

fn local_name(qname: &str) -> &str {
  match qname.rsplit_once(':') {
    Some((_, local)) => local,
    None => qname,
  }
}

fn is_valid_xml_name(name: &str) -> bool {
  let mut chars = name.chars();
  let Some(first) = chars.next() else {
    return false;
  };
  let valid_start = first.is_alphabetic() || matches!(first, '_' | ':');
  if !valid_start {
    return false;
  }
  chars.all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '.' | ':'))
}

fn skip_ascii_ws(bytes: &[u8], mut idx: usize) -> usize {
  while bytes.get(idx).is_some_and(u8::is_ascii_whitespace) {
    idx = idx.saturating_add(1);
  }
  idx
}

fn xml_err(msg: &str) -> ParseOutcome {
  ParseOutcome::XmlError(msg.to_string())
}

fn parse_open_tag(rest: &str) -> Result<(&str, bool, usize), ParseOutcome> {
  let bytes = rest.as_bytes();
  let mut idx = 1usize;
  let name_start = idx;
  while let Some(&b) = bytes.get(idx) {
    if b.is_ascii_whitespace() || matches!(b, b'>' | b'/') {
      break;
    }
    idx = idx.saturating_add(1);
  }
  let name = rest
    .get(name_start..idx)
    .ok_or_else(|| xml_err("invalid tag name"))?;
  if !is_valid_xml_name(name) {
    return Err(xml_err("invalid tag name"));
  }

  loop {
    idx = skip_ascii_ws(bytes, idx);
    match bytes.get(idx) {
      Some(&b'>') => return Ok((name, false, idx.saturating_add(1))),
      Some(&b'/') => {
        if bytes.get(idx.saturating_add(1)) == Some(&b'>') {
          return Ok((name, true, idx.saturating_add(2)));
        }
        return Err(xml_err("malformed self-closing tag"));
      }
      None => return Err(xml_err("unterminated opening tag")),
      Some(_) => {}
    }

    let attr_start = idx;
    while let Some(&b) = bytes.get(idx) {
      if b.is_ascii_whitespace() || b == b'=' {
        break;
      }
      if matches!(b, b'<' | b'>' | b'/') {
        return Err(xml_err("malformed attribute name"));
      }
      idx = idx.saturating_add(1);
    }
    let attr_name = rest
      .get(attr_start..idx)
      .ok_or_else(|| xml_err("invalid attribute name"))?;
    if !is_valid_xml_name(attr_name) {
      return Err(xml_err("invalid attribute name"));
    }

    idx = skip_ascii_ws(bytes, idx);
    if bytes.get(idx) != Some(&b'=') {
      return Err(xml_err("expected '=' in attribute"));
    }
    idx = skip_ascii_ws(bytes, idx.saturating_add(1));

    let Some(&quote) = bytes.get(idx) else {
      return Err(xml_err("unterminated attribute"));
    };
    if quote != b'"' && quote != b'\'' {
      return Err(xml_err("unquoted attribute value"));
    }
    idx = idx.saturating_add(1);

    let mut closed = false;
    while let Some(&b) = bytes.get(idx) {
      if b == quote {
        idx = idx.saturating_add(1);
        closed = true;
        break;
      }
      if b == b'<' {
        return Err(xml_err("invalid '<' in attribute"));
      }
      idx = idx.saturating_add(1);
    }
    if !closed {
      return Err(xml_err("unterminated attribute value"));
    }
  }
}

fn decode_xml_entities(text: &str) -> Result<String, ParseOutcome> {
  if !text.contains('&') {
    return Ok(text.to_string());
  }
  let mut out = String::with_capacity(text.len());
  let mut i = 0usize;
  while let Some(rest) = text.get(i..) {
    if let Some(amp_rel) = rest.find('&') {
      if let Some(before) = rest.get(..amp_rel) {
        out.push_str(before);
      }
      let after_amp_idx = i.saturating_add(amp_rel).saturating_add(1);
      let after_amp = text.get(after_amp_idx..).unwrap_or("");
      let Some(semi_rel) = after_amp.find(';') else {
        return Err(ParseOutcome::XmlError(
          "unterminated entity reference".to_string(),
        ));
      };
      let entity = after_amp.get(..semi_rel).unwrap_or("");
      decode_entity_into(entity, &mut out)?;
      i = after_amp_idx.saturating_add(semi_rel).saturating_add(1);
    } else {
      out.push_str(rest);
      break;
    }
  }
  Ok(out)
}

fn decode_entity_into(entity: &str, out: &mut String) -> Result<(), ParseOutcome> {
  if let Some(num) = entity.strip_prefix('#') {
    let code = if let Some(hex) = num.strip_prefix('x').or_else(|| num.strip_prefix('X')) {
      u32::from_str_radix(hex, 16).ok()
    } else {
      num.parse::<u32>().ok()
    };
    let ch = code
      .and_then(char::from_u32)
      .ok_or_else(|| ParseOutcome::XmlError("invalid numeric entity".to_string()))?;
    out.push(ch);
    return Ok(());
  }

  let valid_name = !entity.is_empty()
    && entity
      .bytes()
      .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'));
  if !valid_name {
    return Err(ParseOutcome::XmlError(
      "invalid character in entity name".to_string(),
    ));
  }

  if let Some(ch) = lookup_named_entity(entity) {
    out.push(ch);
  } else {
    out.push('&');
    out.push_str(entity);
    out.push(';');
  }
  Ok(())
}
