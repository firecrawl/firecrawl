use base64::Engine;

use super::{
  document::Document,
  error::ScrapeURLError,
  formats::FormatKind,
  kinded::{KindedSet, kinded},
  meta::Meta,
  raw_page::{RawPageContent, RawPageResult},
};

pub use self::pdf::{PdfBlockItem, PdfPage};

mod document;
mod fallback;
mod pdf;

#[kinded(noun = "parser", default = [Pdf, Image])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Parser {
  Pdf(pdf::PdfOptions),
  Image,
}

pub type Parsers = KindedSet<Parser>;

#[tracing::instrument(
  name = "parsers::parse_engine_result",
  skip(meta, result),
  fields(parser = tracing::field::Empty, raw_base64.bytes = tracing::field::Empty),
  err
)]
pub async fn parse_engine_result(
  meta: &Meta,
  result: RawPageResult,
) -> Result<Document, ScrapeURLError> {
  // Only engine-delivered bytes are the original response body.
  let raw_base64 = match &result.content {
    RawPageContent::Bytes(bytes) if meta.options.formats.contains(FormatKind::RawBase64) => {
      tracing::Span::current().record("raw_base64.bytes", bytes.len());
      Some(base64::engine::general_purpose::STANDARD.encode(bytes))
    }
    _ => None,
  };

  let mut document = if pdf::has_pdf_signal(&result) {
    tracing::Span::current().record("parser", "pdf");
    pdf::parse_pdf(meta, result).await?
  } else if document::has_document_signal(&result) {
    tracing::Span::current().record("parser", "document");
    document::parse_document(meta, result)?
  } else {
    tracing::Span::current().record("parser", "fallback");
    fallback::parse_fallback(meta, result)?
  };

  document.raw_base64 = raw_base64;
  Ok(document)
}
