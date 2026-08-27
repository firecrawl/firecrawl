use super::{
  document::Document,
  engines::EngineScrapeResult,
  error::ScrapeURLError,
  kinded::{KindedSet, kinded},
  meta::Meta,
};

pub use self::pdf::{PdfBlockItem, PdfPage};

mod document;
mod fallback;
mod pdf;

#[kinded(noun = "parser", default = [Pdf])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Parser {
  Pdf(pdf::PdfOptions),
}

pub type Parsers = KindedSet<Parser>;

pub async fn parse_engine_result(
  meta: &Meta,
  result: EngineScrapeResult,
) -> Result<Document, ScrapeURLError> {
  if pdf::has_pdf_signal(&result) {
    pdf::parse_pdf(meta, result).await
  } else if document::has_document_signal(&result) {
    document::parse_document(meta, result)
  } else {
    fallback::parse_fallback(meta, result)
  }
}
