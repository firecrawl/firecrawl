//! Byte-level magic header sniffing for PDFs, Office containers, and unsupported binaries.

pub(crate) const PDF_HEADER_WINDOW: usize = 1024;
pub(crate) const PDF_MAGIC: &[u8] = b"%PDF-";
pub(crate) const RTF_MAGIC: &[u8] = b"{\\rtf";
pub(crate) const ZIP_LOCAL_HEADER: &[u8] = b"PK\x03\x04";
const ZIP_EMPTY_ARCHIVE: &[u8] = b"PK\x05\x06";
const ZIP_SPANNED_ARCHIVE: &[u8] = b"PK\x07\x08";
pub(crate) const OLE2_SIGNATURE: &[u8] = &[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
const BINARY_SNIFF_LIMIT: usize = 8192;

/// Checks for the `%PDF-` header starting within the first 1024 bytes, matching
/// `pdf-inspector`'s header probe window.
pub(crate) fn sniff_pdf_bytes(bytes: &[u8]) -> bool {
  let probe_end = PDF_HEADER_WINDOW
    .saturating_add(PDF_MAGIC.len())
    .min(bytes.len());
  bytes.get(..probe_end).is_some_and(|window| {
    window
      .windows(PDF_MAGIC.len())
      .take(PDF_HEADER_WINDOW)
      .any(|w| w == PDF_MAGIC)
  })
}

/// Detects unambiguous binary formats by magic header (excluding PDF, RTF, OLE2,
/// and OOXML/ODF/EPUB ZIP containers which are checked beforehand).
pub(crate) fn sniff_unsupported_binary_magic(bytes: &[u8]) -> Option<&'static str> {
  if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
    return Some("image/png");
  }
  if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
    return Some("image/jpeg");
  }
  if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
    return Some("image/gif");
  }
  if bytes.starts_with(b"RIFF") {
    match bytes.get(8..12) {
      Some(b"WEBP") => return Some("image/webp"),
      Some(b"WAVE") => return Some("audio/wav"),
      Some(b"AVI ") => return Some("video/x-msvideo"),
      _ => {}
    }
  }
  if bytes.starts_with(&[0x49, 0x49, 0x2A, 0x00]) || bytes.starts_with(&[0x4D, 0x4D, 0x00, 0x2A]) {
    return Some("image/tiff");
  }
  if bytes.starts_with(&[0x00, 0x00, 0x01, 0x00]) {
    return Some("image/x-icon");
  }
  if bytes.starts_with(b"BM") && bytes.len() >= 14 && bytes.get(6..10) == Some(&[0, 0, 0, 0]) {
    return Some("image/bmp");
  }
  if bytes.get(4..8) == Some(b"ftyp") {
    return match bytes.get(8..12) {
      Some(b"avif" | b"avis") => Some("image/avif"),
      Some(b"heic" | b"heix" | b"mif1" | b"msf1") => Some("image/heif"),
      Some(_) => Some("video/mp4"),
      None => None,
    };
  }
  if bytes.starts_with(&[0x1F, 0x8B, 0x08]) {
    return Some("application/gzip");
  }
  if bytes.starts_with(b"BZh") && bytes.get(3).is_some_and(|b| (b'1'..=b'9').contains(b)) {
    return Some("application/x-bzip2");
  }
  if bytes.starts_with(&[0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00]) {
    return Some("application/x-xz");
  }
  if bytes.starts_with(&[0x28, 0xB5, 0x2F, 0xFD]) {
    return Some("application/zstd");
  }
  if bytes.starts_with(&[0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C]) {
    return Some("application/x-7z-compressed");
  }
  if bytes.starts_with(&[0x52, 0x61, 0x72, 0x21, 0x1A, 0x07]) {
    return Some("application/x-rar-compressed");
  }
  if bytes.get(257..262) == Some(b"ustar") {
    return Some("application/x-tar");
  }
  if bytes.starts_with(b"\x7fELF")
    || bytes.starts_with(&[0xFE, 0xED, 0xFA, 0xCE])
    || bytes.starts_with(&[0xFE, 0xED, 0xFA, 0xCF])
    || bytes.starts_with(&[0xCE, 0xFA, 0xED, 0xFE])
    || bytes.starts_with(&[0xCF, 0xFA, 0xED, 0xFE])
    || bytes.starts_with(&[0xCA, 0xFE, 0xBA, 0xBE])
  {
    return Some("application/x-executable");
  }
  if bytes.starts_with(&[0x00, 0x61, 0x73, 0x6D]) {
    return Some("application/wasm");
  }
  if bytes.starts_with(b"SQLite format 3\0") {
    return Some("application/vnd.sqlite3");
  }
  if bytes.starts_with(b"OggS") {
    return Some("audio/ogg");
  }
  if bytes.starts_with(b"fLaC") {
    return Some("audio/flac");
  }
  if bytes.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
    return Some("video/webm");
  }
  if bytes.starts_with(b"ID3")
    && bytes.len() >= 10
    && bytes.get(3).is_some_and(|b| *b < 0xFF)
    && bytes.get(4).is_some_and(|b| *b < 0xFF)
    && bytes.get(5).is_some_and(|b| (b & 0x0F) == 0)
  {
    return Some("audio/mpeg");
  }
  if bytes.starts_with(ZIP_LOCAL_HEADER)
    || bytes.starts_with(ZIP_EMPTY_ARCHIVE)
    || bytes.starts_with(ZIP_SPANNED_ARCHIVE)
  {
    return Some("application/zip");
  }
  None
}

/// Heuristic check for opaque binary payloads lacking a declared text media
/// type: flags NUL bytes (except UTF-8/UTF-16 BOM payloads) or >30% C0 control
/// bytes within the first 8 KiB.
pub(crate) fn looks_like_opaque_binary(bytes: &[u8]) -> bool {
  if bytes.is_empty() {
    return false;
  }
  if encoding_rs::Encoding::for_bom(bytes).is_some() {
    return false;
  }
  let sample = bytes
    .get(..bytes.len().min(BINARY_SNIFF_LIMIT))
    .unwrap_or(bytes);
  let mut control_count: usize = 0;
  for &byte in sample {
    if byte == 0 {
      return true;
    }
    if byte < 0x20 && !matches!(byte, b'\t' | b'\n' | b'\r' | 0x0B | 0x0C | 0x1B) {
      control_count = control_count.saturating_add(1);
    }
  }
  control_count.saturating_mul(10) > sample.len().saturating_mul(3)
}
