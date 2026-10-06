//! Signals that a page or file is a PDF.

use bytes::Bytes;

pub fn pdf_content_type_match(content_type: &str) -> bool {
  let normalized = content_type.to_lowercase();

  normalized == "application/pdf" || normalized.starts_with("application/pdf;")
}

pub fn pdf_binary_match(bytes: &Bytes) -> bool {
  bytes[..usize::min(bytes.len(), 1024)]
    .windows(4)
    .any(|w| w == b"%PDF")
}

pub fn pdf_base64_match(base64: &str) -> bool {
  base64.starts_with("JVBERi")
}

pub fn pdf_file_extension_match(filename: &str) -> bool {
  filename.ends_with(".pdf")
}
