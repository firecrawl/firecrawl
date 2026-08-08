use super::{document::Document, engines::EngineScrapeResult, error::ScrapeURLError, meta::Meta};

mod document;
mod fallback;
mod pdf;

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
