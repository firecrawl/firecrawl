use bytes::Bytes;

use super::super::{
  document::Document,
  engines::{EngineScrapeContent, EngineScrapeResult},
  error::ScrapeURLError,
  meta::Meta,
};

fn pdf_content_type_match(content_type: &str) -> bool {
  let normalized = content_type.to_lowercase();

  normalized == "application/pdf" || normalized.starts_with("application/pdf;")
}

fn pdf_binary_match(bytes: &Bytes) -> bool {
  bytes.starts_with(&[0x25, 0x50, 0x44, 0x46]) // base64: JVBERi
}

fn pdf_file_extension_match(filename: &str) -> bool {
  filename.ends_with(".pdf")
}

pub fn has_pdf_signal(result: &EngineScrapeResult) -> bool {
  let is_pdf_content_type = pdf_content_type_match(&result.content_type);

  let is_pdf_binary = match &result.content {
    EngineScrapeContent::Bytes(bytes) => pdf_binary_match(&bytes),
    _ => false,
  };

  let is_pdf_file_extension = result
    .filename
    .as_ref()
    .map(|x| pdf_file_extension_match(x))
    .unwrap_or(false);

  is_pdf_content_type || is_pdf_binary || is_pdf_file_extension
}

pub async fn parse_pdf(
  meta: &Meta,
  result: EngineScrapeResult,
) -> Result<Document, ScrapeURLError> {
  unimplemented!()
}
