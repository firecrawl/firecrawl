use std::{collections::HashMap, str::FromStr};

use bytes::Bytes;
use encoding_rs::{Encoding, UTF_8};
use mime::Mime;
use regex::regex;

use super::super::{
  document::{Document, DocumentMetadata, DocumentMetadataCacheState},
  engines::{EngineScrapeContent, EngineScrapeResult},
  error::ScrapeURLError,
  meta::Meta,
};

fn deduce_encoding(result: &EngineScrapeResult, content: &Bytes) -> &'static Encoding {
  let lossy_text = String::from_utf8_lossy(content.as_ref());

  {
    if let Some(content_type_charset) = Mime::from_str(&result.content_type)
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
  let content = match &result.content {
    EngineScrapeContent::Bytes(bytes) => {
      let encoding = deduce_encoding(&result, bytes);
      &encoding.decode(bytes.as_ref()).0.to_string()
    }
    EngineScrapeContent::DecodedText(text) => text,
  };

  Ok(Document {
    markdown: None,
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
    warning: None,
    // actions:
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
