//! Charset-aware plain text, HTML, XML, JSON, and Markdown fallback parser.

use std::sync::LazyLock;

use base64::Engine;
use encoding_rs::{Encoding, UTF_8};
use firecrawl_core_types::{CoreParserKind, ParseRawDocumentResult};
use regex::bytes::Regex;

use crate::formats::media_type;

const META_CHARSET_SNIFF_LIMIT: usize = 4096;

static META_CHARSET_RE: LazyLock<Option<Regex>> =
  LazyLock::new(|| Regex::new(r#"(?i-u)<meta[\s/][^>]*?charset\s*=\s*["']?([^"'>;,\s/]+)"#).ok());

fn extract_content_type_charset(content_type: &str) -> Option<&str> {
  for part in content_type.split(';').skip(1) {
    let Some((key, raw_val)) = part.split_once('=') else {
      continue;
    };
    if !key.trim().eq_ignore_ascii_case("charset") {
      continue;
    }
    let val = raw_val
      .trim()
      .trim_matches(|c| c == '"' || c == '\'')
      .trim();
    if !val.is_empty() {
      return Some(val);
    }
  }
  None
}

/// Deduces the text encoding from BOM, Content-Type charset parameter, or HTML
/// `<meta charset=...>` header, defaulting to UTF-8.
pub(crate) fn deduce_encoding(bytes: &[u8], content_type: &str) -> &'static Encoding {
  if let Some((bom_encoding, _)) = Encoding::for_bom(bytes) {
    return bom_encoding;
  }
  if let Some(encoding) = extract_content_type_charset(content_type)
    .and_then(|label| Encoding::for_label(label.as_bytes()))
  {
    return encoding;
  }
  let mt = media_type(content_type);
  if mt == "text/html" || mt == "application/xhtml+xml" {
    let head = bytes
      .get(..bytes.len().min(META_CHARSET_SNIFF_LIMIT))
      .unwrap_or(bytes);
    if let Some(encoding) = META_CHARSET_RE
      .as_ref()
      .and_then(|re| re.captures(head))
      .and_then(|caps| caps.get(1))
      .and_then(|m| Encoding::for_label(m.as_bytes()))
    {
      return encoding;
    }
  }
  UTF_8
}

/// Decodes raw text/HTML/XML/JSON bytes using charset deduction with UTF-8
/// lossy fallback and builds a `ParseRawDocumentResult`.
pub(crate) fn parse_fallback_bytes(
  raw_bytes: &[u8],
  content_type: String,
  wants_raw_base64: bool,
) -> ParseRawDocumentResult {
  let encoding = deduce_encoding(raw_bytes, &content_type);
  let (decoded, _, _) = encoding.decode(raw_bytes);
  let text = decoded.into_owned();
  let mt = media_type(&content_type);

  let markdown = if mt == "application/json" || mt.ends_with("+json") {
    Some(format!("```json\n{text}\n```"))
  } else if mt == "text/html" || mt == "application/xhtml+xml" {
    None
  } else {
    Some(text.clone())
  };

  let raw_base64 =
    wants_raw_base64.then(|| base64::engine::general_purpose::STANDARD.encode(raw_bytes));

  ParseRawDocumentResult {
    parser: CoreParserKind::Fallback,
    content_type,
    markdown,
    html: None,
    raw_html: Some(text),
    raw_base64,
    title: None,
    num_pages: None,
    total_pages: None,
    pdf_inspection: None,
    warning: None,
  }
}
