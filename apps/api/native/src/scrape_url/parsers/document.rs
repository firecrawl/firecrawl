use std::collections::HashMap;

use bytes::Bytes;

use super::super::{
  document::{Document, DocumentMetadata, DocumentMetadataCacheState},
  engines::{EngineScrapeContent, EngineScrapeResult},
  error::ScrapeURLError,
  meta::Meta,
};

fn document_content_type_match(content_type: &str) -> bool {
  let normalized = content_type.to_lowercase();

  normalized == "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    || normalized == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    || normalized == "application/vnd.ms-excel"
    || normalized == "application/msword"
    || normalized == "application/rtf"
    || normalized == "text/rtf"
    || normalized == "application/vnd.oasis.opendocument.text"
}

fn document_binary_match(bytes: &Bytes) -> bool {
  bytes.starts_with(&[0x50, 0x4b, 0x03]) // base64: UEsD
    || bytes.starts_with(&[0xd0, 0xcf, 0x11, 0xe0]) // base64: 0M8R4K
}

fn document_file_extension_match(filename: &str) -> bool {
  filename.ends_with(".docx")
    || filename.ends_with(".doc")
    || filename.ends_with(".odt")
    || filename.ends_with(".rtf")
    || filename.ends_with(".xlsx")
    || filename.ends_with(".xls")
}

pub fn has_document_signal(result: &EngineScrapeResult) -> bool {
  let is_document_content_type = document_content_type_match(&result.content_type);

  let is_document_binary = match &result.content {
    EngineScrapeContent::Bytes(bytes) => document_binary_match(bytes),
    _ => false,
  };

  let is_document_file_extension = result
    .filename
    .as_ref()
    .map(|x| document_file_extension_match(x))
    .unwrap_or(false);

  is_document_content_type || is_document_binary || is_document_file_extension
}

pub fn parse_document(meta: &Meta, result: EngineScrapeResult) -> Result<Document, ScrapeURLError> {
  let bytes = match &result.content {
    EngineScrapeContent::Bytes(bytes) => bytes,
    _ => unreachable!(),
  };

  let format = anydoc::Format::from_bytes(bytes.as_ref()).or_else(|| {
    result
      .filename
      .as_deref()
      .map(|ext| ext.trim_start_matches('.'))
      .and_then(anydoc::Format::from_extension)
  });

  let markdown = anydoc::to_markdown_bytes(bytes.as_ref(), format).unwrap();

  Ok(Document {
    markdown: Some(markdown),
    html: None,
    raw_html: None, // TODO: md -> html
    links: None,
    images: None,
    screenshot: None,
    audio: None,
    video: None,
    summary: None,
    answer: None,
    highlights: None,
    warning: None,
    metadata: DocumentMetadata {
      scrape_id: meta.id.clone(),
      source_url: meta.source_url(),
      url: result.url,
      status_code: result.status_code,
      num_pages: None, // TODO: should we set this in document? on prod we don't. will this mess with billing?
      title: None,     // TODO: ^
      content_type: result.content_type,
      timezone: result.timezone,
      proxy_used: result.proxy_used,
      cache_state: DocumentMetadataCacheState::Miss, // TODO:
      cached_at: None,                               // TODO:
      index_id: None,                                // TODO:
      credits_used: None,                            // TODO:
      concurrency_limited: false,                    // TODO:
      concurrency_queue_duration_ms: None,           // TODO:
      extra: HashMap::new(),
    },
  })
}
