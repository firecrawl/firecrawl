use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Convert a document (doc, docx, odt/ods/odp, rtf, xls/xlsx, ppt/pptx, epub,
/// csv, ...) to GitHub-Flavored Markdown using anydoc. The format is detected
/// from the file content; `extension_hint` (with or without a leading dot) is
/// only consulted for signature-less formats like CSV.
#[napi]
pub fn convert_document_to_markdown(data: &[u8], extension_hint: Option<String>) -> Result<String> {
  let format = anydoc::Format::from_bytes(data).or_else(|| {
    extension_hint
      .as_deref()
      .map(|ext| ext.trim_start_matches('.'))
      .and_then(anydoc::Format::from_extension)
  });

  anydoc::to_markdown_bytes(data, format)
    .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))
}
