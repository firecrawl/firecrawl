//! Byte-level magic header sniffing for PDFs, Office containers, and unsupported binaries.

pub(crate) const PDF_HEADER_WINDOW: usize = 1024;
pub(crate) const PDF_MAGIC: &[u8] = b"%PDF-";
pub(crate) const RTF_MAGIC: &[u8] = b"{\\rtf";
pub(crate) const ZIP_LOCAL_HEADER: &[u8] = b"PK\x03\x04";
const ZIP_EMPTY_ARCHIVE: &[u8] = b"PK\x05\x06";
const ZIP_SPANNED_ARCHIVE: &[u8] = b"PK\x07\x08";
pub(crate) const OLE2_SIGNATURE: &[u8] = &[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
const BINARY_SNIFF_LIMIT: usize = 8192;
const EBML_DOCTYPE_PROBE_LIMIT: usize = 64;

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

fn sniff_iso_bmff(bytes: &[u8]) -> Option<&'static str> {
  if bytes.len() < 12 || bytes.get(4..8) != Some(b"ftyp") {
    return None;
  }
  // Box size is a big-endian u32; valid ftyp headers are small (< 64 KiB).
  if bytes.get(0..2) != Some(&[0, 0]) {
    return None;
  }
  match bytes.get(8..12) {
    Some(b"avif" | b"avis") => Some("image/avif"),
    Some(b"heic" | b"heix" | b"hevc" | b"hevx" | b"heim" | b"heis" | b"mif1" | b"msf1") => {
      Some("image/heif")
    }
    Some(b"qt  ") => Some("video/quicktime"),
    Some(b"M4A " | b"M4B " | b"M4P ") => Some("audio/mp4"),
    Some(b"3gp4" | b"3gp5" | b"3gp6" | b"3gp7" | b"3gp8" | b"3gp9" | b"3g2a") => Some("video/3gpp"),
    Some(
      b"isom" | b"iso2" | b"iso5" | b"iso6" | b"mp41" | b"mp42" | b"M4V " | b"avc1" | b"dash",
    ) => Some("video/mp4"),
    Some(_) => Some("application/octet-stream"),
    None => None,
  }
}

fn sniff_ebml(bytes: &[u8]) -> Option<&'static str> {
  if !bytes.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
    return None;
  }
  let window = bytes
    .get(..bytes.len().min(EBML_DOCTYPE_PROBE_LIMIT))
    .unwrap_or(bytes);
  // Look for EBML DocType element ID (0x42 0x82) followed by a 1-byte VINT size.
  for idx in 0..window.len().saturating_sub(3) {
    if window.get(idx..idx.saturating_add(2)) != Some(&[0x42, 0x82]) {
      continue;
    }
    let Some(&vint) = window.get(idx.saturating_add(2)) else {
      break;
    };
    if (vint & 0x80) == 0 {
      continue;
    }
    let len = usize::from(vint & 0x7F);
    let start = idx.saturating_add(3);
    let end = start.saturating_add(len);
    if let Some(doc_type) = window.get(start..end) {
      if doc_type == b"webm" {
        return Some("video/webm");
      }
      if doc_type == b"matroska" {
        return Some("video/x-matroska");
      }
    }
  }
  Some("application/octet-stream")
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
  if (bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"))
    && let Some(&[w0, w1, h0, h1]) = bytes.get(6..10)
  {
    let w = u16::from_le_bytes([w0, w1]);
    let h = u16::from_le_bytes([h0, h1]);
    let has_binary_framing = [w0, w1, h0, h1].contains(&0)
      || bytes
        .get(10..)
        .is_some_and(|rest| rest.iter().any(|&b| b == 0 || b >= 0x80));
    if w > 0 && h > 0 && has_binary_framing {
      return Some("image/gif");
    }
  }
  if bytes.starts_with(b"RIFF")
    && bytes.len() >= 12
    && bytes
      .get(4..8)
      .is_some_and(|sz| sz.iter().any(|&b| !(0x20..0x7F).contains(&b)))
  {
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
  if let Some(mime) = sniff_iso_bmff(bytes) {
    return Some(mime);
  }
  if bytes.starts_with(&[0x1F, 0x8B, 0x08]) {
    return Some("application/gzip");
  }
  if bytes.starts_with(b"BZh")
    && bytes.get(3).is_some_and(|b| (b'1'..=b'9').contains(b))
    && matches!(
      bytes.get(4..10),
      Some(&[0x31, 0x41, 0x59, 0x26, 0x53, 0x59] | &[0x17, 0x72, 0x45, 0x38, 0x50, 0x90])
    )
  {
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
  if bytes.get(257..262) == Some(b"ustar")
    && matches!(bytes.get(262..264), Some(&[0x00, b'0'] | b"  "))
  {
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
  if bytes.starts_with(b"OggS") && bytes.len() >= 28 && bytes.get(4) == Some(&0) {
    return Some("audio/ogg");
  }
  if bytes.starts_with(b"fLaC")
    && bytes.len() >= 8
    && bytes.get(4).is_some_and(|b| (*b & 0x7F) == 0)
  {
    return Some("audio/flac");
  }
  if let Some(mime) = sniff_ebml(bytes) {
    return Some(mime);
  }
  if bytes.starts_with(b"ID3")
    && bytes.len() >= 10
    && bytes.get(3).is_some_and(|b| (2..=4).contains(b))
    && bytes.get(4).is_some_and(|b| *b < 0xFF)
    && bytes.get(5).is_some_and(|b| (b & 0x0F) == 0)
    && bytes
      .get(6..10)
      .is_some_and(|sz| sz.iter().all(|b| *b < 0x80))
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
