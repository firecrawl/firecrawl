use std::{collections::HashMap, str::FromStr};

use bytes::Bytes;
use encoding_rs::{Encoding, UTF_8};
use mime::Mime;
use regex::regex;

use crate::_get_inner_json;

use super::super::{
  document::{Document, DocumentMetadata, DocumentMetadataCacheState},
  engines::{EngineScrapeContent, EngineScrapeResult},
  error::ScrapeURLError,
  meta::Meta,
};

fn deduce_encoding(content: &Bytes, content_type: &str) -> &'static Encoding {
  let lossy_text = String::from_utf8_lossy(content.as_ref());

  {
    if let Some(content_type_charset) = Mime::from_str(content_type)
      .ok()
      .and_then(|m| m.get_param(mime::CHARSET).map(|v| v.to_string()))
    {
      Encoding::for_label(content_type_charset.as_bytes())
    } else if let Some(meta_charset) =
      regex!(r#"(?i-u)<meta[\s/][^>]*?charset\s*=\s*["']?([^"'>;,\s/]+)"#)
        .captures(&lossy_text)
        .and_then(|x| x.get(1))
        .map(|x| x.as_str())
    {
      Encoding::for_label(meta_charset.as_bytes())
    } else {
      None
    }
  }
  .unwrap_or(UTF_8)
}

pub fn parse_fallback(meta: &Meta, result: EngineScrapeResult) -> Result<Document, ScrapeURLError> {
  let (content, markdown): (String, Option<String>) = match result.content {
    EngineScrapeContent::Bytes(bytes) => {
      let encoding = deduce_encoding(&bytes, &result.content_type);
      (encoding.decode(bytes.as_ref()).0.to_string(), None)
    }
    EngineScrapeContent::ChromeRenderedDOM(text) => {
      if result.content_type.contains("application/json") {
        // JSON needs to be extracted from <html><body> wrapping done by Chrome to
        // still be valid. We can also add some Markdown flavoring.
        let json = _get_inner_json(&text).unwrap_or(text);
        let markdown = Some(format!("```json\n{}\n```", json));
        (json, markdown)
      } else if result.content_type.contains("text/plain") {
        // text/plain responses (e.g. llms.txt) are already plain text/markdown.
        // Running them through the HTML-to-markdown converter escapes markdown
        // punctuation like "_", which corrupts underscores inside link URLs. Pass
        // the raw body through untouched instead.
        let text = _get_inner_json(&text).unwrap_or(text);
        (text.clone(), Some(text))
      } else {
        (text, None)
      }
    }
    EngineScrapeContent::GeneratedMarkdown(md) => (
      markdown::to_html_with_options(&md, &markdown::Options::gfm())
        .expect("this error is impossible"),
      Some(md),
    ),
  };

  Ok(Document {
    markdown: markdown,
    html: None,
    raw_html: Some(content.to_owned()),
    screenshot: result.screenshot,
    links: None,
    images: None,
    audio: None,
    video: None,
    summary: None,
    answer: None,
    highlights: None,
    attributes: None,
    actions: result.actions,
    warning: None,
    // branding:
    metadata: DocumentMetadata {
      scrape_id: meta.id.clone(),
      source_url: meta.source_url(),
      url: result.url,
      status_code: result.status_code,
      num_pages: None,
      title: None,
      content_type: result.content_type,
      timezone: result.timezone,
      proxy_used: result.proxy_used,
      cache_state: DocumentMetadataCacheState::Miss,
      cached_at: None,
      index_id: None,
      credits_used: None,
      concurrency_limited: false,
      concurrency_queue_duration_ms: None,

      extra: HashMap::new(),
    },
  })
}
