//! The Documents a PDF parse returns.

use base64::Engine;
use bytes::Bytes;
use url::Url;

use super::{
  super::super::{
    document::{Document, DocumentMetadata, DocumentMetadataCacheState},
    error::ScrapeURLError,
    index::IndexPDFMetadata,
    meta::Meta,
    raw_page::{RawPageActions, RawPageResult, ScrapeProxy},
  },
  firepdf::{FirePdfResult, WirePage, WirePageBlocks},
  html::markdown_to_html,
  limits::PDF_DOWNLOAD_MAX_FILE_SIZE,
  types::{PdfOptions, PdfPage, PdfPageBlocks},
};

/// Everything from the engine result besides the file itself.
pub struct PageInfo {
  url: Url,
  status_code: u16,
  screenshot: Option<Url>,
  actions: Option<RawPageActions>,
  content_type: String,
  proxy_used: ScrapeProxy,
  timezone: Option<String>,
}

impl PageInfo {
  pub fn split(result: RawPageResult) -> (Self, super::super::super::raw_page::RawPageContent) {
    let RawPageResult {
      url,
      status_code,
      content,
      screenshot,
      actions,
      content_type,
      proxy_used,
      timezone,
      ..
    } = result;
    let page = Self {
      url,
      status_code,
      screenshot,
      actions,
      content_type,
      proxy_used,
      timezone,
    };
    (page, content)
  }
}

/// Markdown and HTML of a parse, with FirePDF's page-aware sidecars when it produced them.
pub struct Parsed {
  pub markdown: String,
  pub html: String,
  pub pages: Option<Vec<WirePage>>,
  pub blocks: Option<Vec<WirePageBlocks>>,
}

impl Parsed {
  pub async fn from_markdown(markdown: String) -> Self {
    let (markdown, html) = markdown_to_html(markdown).await;
    Self {
      markdown,
      html,
      pages: None,
      blocks: None,
    }
  }
}

impl From<FirePdfResult> for Parsed {
  fn from(result: FirePdfResult) -> Self {
    Self {
      markdown: result.markdown,
      html: result.html,
      pages: result.page_markdown,
      blocks: result.blocks,
    }
  }
}

/// Page counts and title reported on `metadata`.
pub struct PdfFacts {
  pub num_pages: Option<u32>,
  pub total_pages: Option<u32>,
  pub title: Option<String>,
}

fn metadata(
  meta: &Meta,
  page: &PageInfo,
  content_type: String,
  facts: PdfFacts,
) -> DocumentMetadata {
  DocumentMetadata {
    scrape_id: meta.id.clone(),
    source_url: meta.source_url(),
    url: page.url.clone(),
    status_code: page.status_code,
    content_type,
    timezone: page.timezone.clone(),
    proxy_used: page.proxy_used,
    cache_state: DocumentMetadataCacheState::Miss,
    cached_at: None,
    index_id: None,
    credits_used: None,
    concurrency_limited: false,
    concurrency_queue_duration_ms: None,
    title: facts.title,
    num_pages: facts.num_pages,
    total_pages: facts.total_pages,
    extra: Default::default(),
  }
}

fn document(metadata: DocumentMetadata, actions: Option<RawPageActions>) -> Document {
  Document {
    markdown: None,
    html: None,
    raw_html: None,
    raw_base64: None,
    links: None,
    images: None,
    screenshot: None,
    audio: None,
    video: None,
    json: None,
    summary: None,
    answer: None,
    highlights: None,
    pages: None,
    blocks: None,
    warning: None,
    attributes: None,
    actions,
    metadata,
  }
}

/// This PDF got decoded and the decoded version got saved to the index. Serve it as a done document.
pub fn indexed_document(
  meta: &Meta,
  page: PageInfo,
  html: String,
  pdf_metadata: Option<IndexPDFMetadata>,
) -> Document {
  let facts = PdfFacts {
    num_pages: pdf_metadata.as_ref().map(|x| x.num_pages),
    total_pages: pdf_metadata.as_ref().and_then(|x| x.total_pages),
    title: pdf_metadata.and_then(|x| x.title),
  };
  let content_type = page.content_type.clone();
  let mut document = document(metadata(meta, &page, content_type, facts), page.actions);
  document.raw_base64 = Some(base64::engine::general_purpose::STANDARD.encode(&html)); // TODO: THIS IS FAKE RAW
  document.raw_html = Some(html);
  document.screenshot = page.screenshot;
  document
}

/// The file itself, base64'd, when PDF parsing is off. It travels inline, so it keeps the historical cap.
pub fn raw_document(
  meta: &Meta,
  page: PageInfo,
  bytes: &Bytes,
) -> Result<Document, ScrapeURLError> {
  if bytes.len() > PDF_DOWNLOAD_MAX_FILE_SIZE {
    return Err(ScrapeURLError::UnsupportedFileError {
      reason: "File exceeds size limit".to_string(),
    });
  }
  let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
  let facts = PdfFacts {
    num_pages: None,
    total_pages: None,
    title: None,
  };
  let mut document = document(
    metadata(meta, &page, "application/pdf".to_string(), facts),
    page.actions,
  );
  document.markdown = Some(encoded.clone());
  document.raw_html = Some(encoded.clone());
  document.raw_base64 = Some(encoded.clone());
  document.html = Some(encoded);
  document.screenshot = page.screenshot;
  Ok(document)
}

pub fn parsed_document(
  meta: &Meta,
  page: PageInfo,
  parser: &PdfOptions,
  parsed: Parsed,
  bytes: &Bytes,
  handed_off: bool,
  facts: PdfFacts,
) -> Document {
  let mut document = document(
    metadata(meta, &page, "application/pdf".to_string(), facts),
    page.actions,
  );
  document.markdown = Some(parsed.markdown);
  document.raw_html = Some(parsed.html);
  // A handed-off file can be up to 256MB; fire-engine never grants the handoff to raw requests.
  document.raw_base64 =
    (!handed_off).then(|| base64::engine::general_purpose::STANDARD.encode(bytes));
  document.pages = parsed
    .pages
    .filter(|_| parser.pages)
    .map(|pages| pages.into_iter().map(PdfPage::from).collect());
  document.blocks = parsed
    .blocks
    .filter(|_| parser.blocks)
    .map(|blocks| blocks.into_iter().map(PdfPageBlocks::from).collect());
  document
}
