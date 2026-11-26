//! Content-Type, filename/extension, and magic-byte classification for raw documents.

use firecrawl_core_types::ParseRawDocumentRequest;

use crate::formats::{
  document_extension_from_media_type, extension_for_anydoc_format, infer_text_content_type,
  is_pdf_extension_hint, media_type, resolve_document_content_type,
  resolve_document_extension_hint,
};
use crate::magic::{
  OLE2_SIGNATURE, RTF_MAGIC, ZIP_LOCAL_HEADER, looks_like_opaque_binary, sniff_pdf_bytes,
  sniff_unsupported_binary_magic,
};

const ZIP_ARCHIVE_MEDIA_TYPES: &[&str] = &[
  "application/zip",
  "application/x-zip-compressed",
  "application/java-archive",
];

const UNSUPPORTED_BINARY_PREFIXES: &[&str] = &[
  "image/",
  "video/",
  "audio/",
  "application/zip",
  "application/x-zip-compressed",
  "application/x-tar",
  "application/x-rar",
  "application/x-7z",
  "application/gzip",
  "application/x-gzip",
  "application/x-bzip2",
  "application/x-xz",
  "application/zstd",
  "application/wasm",
  "application/x-executable",
  "application/x-sharedlib",
  "application/x-mach-binary",
  "application/x-msdownload",
  "application/java-archive",
  "application/vnd.sqlite3",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SniffOutcome {
  Pdf {
    signal: &'static str,
  },
  Document {
    signal: &'static str,
    extension_hint: Option<String>,
    content_type: String,
  },
  Fallback {
    signal: &'static str,
    content_type: String,
  },
  UnsupportedBinary {
    reason: String,
  },
}

fn is_explicit_text_media_type(mt: &str) -> bool {
  mt.starts_with("text/")
    || matches!(
      mt,
      "application/json"
        | "application/ld+json"
        | "application/xml"
        | "application/xhtml+xml"
        | "application/javascript"
        | "application/ecmascript"
        | "application/yaml"
        | "application/x-yaml"
        | "application/toml"
        | "application/x-ndjson"
        | "image/svg+xml"
    )
    || mt.ends_with("+json")
    || mt.ends_with("+xml")
}

fn is_unsupported_binary_content_type(mt: &str) -> bool {
  if mt == "image/svg+xml" {
    return false;
  }
  UNSUPPORTED_BINARY_PREFIXES
    .iter()
    .any(|prefix| mt.starts_with(prefix))
}

/// Classifies raw document bytes by inspecting unambiguous byte signatures
/// first, then falling back to Content-Type, filename, extension hint, and URL
/// path.
pub(crate) fn sniff_document(bytes: &[u8], request: &ParseRawDocumentRequest) -> SniffOutcome {
  let raw_ct = request.content_type.as_deref();
  let mt = raw_ct.map(media_type).unwrap_or_default();
  let ct_doc_ext = document_extension_from_media_type(&mt);
  let hint_ext = resolve_document_extension_hint(request);
  let is_text_ct = is_explicit_text_media_type(&mt);

  // 1. Unambiguous document container magic runs before PDF scanning so an
  // OOXML/ODF package holding an embedded PDF keeps its outer document type.
  if bytes.starts_with(RTF_MAGIC) {
    let ct = resolve_document_content_type(raw_ct, Some(anydoc::Format::Rtf), Some("rtf"));
    return SniffOutcome::Document {
      signal: "magic:rtf",
      extension_hint: Some("rtf".to_string()),
      content_type: ct,
    };
  }
  if bytes.starts_with(OLE2_SIGNATURE) {
    let detected = anydoc::Format::from_bytes(bytes).filter(|f| *f != anydoc::Format::Pdf);
    let ext = detected
      .map(|f| extension_for_anydoc_format(f).to_string())
      .or_else(|| ct_doc_ext.map(str::to_string))
      .or(hint_ext);
    let ct = resolve_document_content_type(raw_ct, detected, ext.as_deref());
    return SniffOutcome::Document {
      signal: "magic:ole2",
      extension_hint: ext,
      content_type: ct,
    };
  }
  if bytes.starts_with(ZIP_LOCAL_HEADER) {
    // Inspect ZIP entries first so DOCX/XLSX/PPTX/ODF/EPUB served with
    // Content-Type: application/zip is still recognized by its inner structure.
    if let Some(fmt) = anydoc::Format::from_bytes(bytes).filter(|f| *f != anydoc::Format::Pdf) {
      let ext = Some(extension_for_anydoc_format(fmt).to_string());
      let ct = resolve_document_content_type(raw_ct, Some(fmt), ext.as_deref());
      return SniffOutcome::Document {
        signal: "magic:zip_office",
        extension_hint: ext,
        content_type: ct,
      };
    }
    if ZIP_ARCHIVE_MEDIA_TYPES.contains(&mt.as_str()) && hint_ext.is_none() {
      return SniffOutcome::UnsupportedBinary { reason: mt };
    }
    if ct_doc_ext.is_some() || hint_ext.is_some() {
      let ext = ct_doc_ext.map(str::to_string).or(hint_ext);
      let ct = resolve_document_content_type(raw_ct, None, ext.as_deref());
      return SniffOutcome::Document {
        signal: "magic:zip_hinted",
        extension_hint: ext,
        content_type: ct,
      };
    }
    let reason = if mt.is_empty() || mt == "application/octet-stream" {
      "application/zip".to_string()
    } else {
      mt
    };
    return SniffOutcome::UnsupportedBinary { reason };
  }

  // 2. Remaining unambiguous magic signatures run before trusting Content-Type
  // headers so mislabeled PDFs or binaries are never routed to the wrong parser.
  if sniff_pdf_bytes(bytes) {
    return SniffOutcome::Pdf {
      signal: "magic:pdf",
    };
  }
  if let Some(mime) = sniff_unsupported_binary_magic(bytes) {
    return SniffOutcome::UnsupportedBinary {
      reason: mime.to_string(),
    };
  }

  // 3. Declared Content-Type headers when bytes had no definitive signature.
  if mt == "application/pdf" {
    return SniffOutcome::Pdf {
      signal: "content_type",
    };
  }
  if let Some(ext) = ct_doc_ext {
    return SniffOutcome::Document {
      signal: "content_type",
      extension_hint: Some(ext.to_string()),
      content_type: resolve_document_content_type(raw_ct, None, Some(ext)),
    };
  }
  if is_unsupported_binary_content_type(&mt) {
    return SniffOutcome::UnsupportedBinary { reason: mt };
  }

  // 4. Filename, extension_hint, and URL path hints.
  if is_pdf_extension_hint(request) && !is_text_ct {
    return SniffOutcome::Pdf {
      signal: "extension",
    };
  }
  if let Some(ext) = hint_ext {
    let csv_under_plain = ext == "csv" && (mt.is_empty() || mt == "text/plain");
    if !is_text_ct || csv_under_plain || request.extension_hint.is_some() {
      let ct = resolve_document_content_type(raw_ct, None, Some(&ext));
      return SniffOutcome::Document {
        signal: "extension",
        extension_hint: Some(ext),
        content_type: ct,
      };
    }
  }
  if (mt.is_empty() || mt == "application/octet-stream" || mt == "binary/octet-stream")
    && looks_like_opaque_binary(bytes)
  {
    let reason = if mt.is_empty() {
      "application/octet-stream".to_string()
    } else {
      mt
    };
    return SniffOutcome::UnsupportedBinary { reason };
  }

  SniffOutcome::Fallback {
    signal: "fallback",
    content_type: infer_text_content_type(bytes, request),
  }
}
