//! Document and text media-type/extension tables matching
//! `apps/api/src/lib/document-formats.ts`.

use firecrawl_core_types::ParseRawDocumentRequest;

/// Canonical mapping from document media types to bare extensions.
const DOCUMENT_CONTENT_TYPES: &[(&str, &str)] = &[
  (
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "docx",
  ),
  ("application/vnd.ms-word.document.macroenabled.12", "docm"),
  ("application/msword", "doc"),
  (
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "xlsx",
  ),
  ("application/vnd.ms-excel", "xls"),
  ("application/vnd.ms-excel.sheet.macroenabled.12", "xlsm"),
  (
    "application/vnd.ms-excel.sheet.binary.macroenabled.12",
    "xlsb",
  ),
  (
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "pptx",
  ),
  ("application/vnd.ms-powerpoint", "ppt"),
  (
    "application/vnd.ms-powerpoint.presentation.macroenabled.12",
    "pptm",
  ),
  ("application/vnd.oasis.opendocument.text", "odt"),
  ("application/vnd.oasis.opendocument.spreadsheet", "ods"),
  ("application/vnd.oasis.opendocument.presentation", "odp"),
  ("application/rtf", "rtf"),
  ("text/rtf", "rtf"),
  ("application/epub+zip", "epub"),
  ("text/csv", "csv"),
];

/// Longest-first document extensions for URL path matching (".docx" before ".doc").
const DOCUMENT_EXTENSIONS_BY_LENGTH: &[&str] = &[
  "docx", "docm", "xlsx", "xlsm", "xlsb", "pptx", "pptm", "epub", "ppsx", "ppsm", "doc", "xls",
  "ppt", "pps", "pot", "odt", "ods", "odp", "rtf", "csv",
];

const TEXT_EXTENSIONS: &[(&str, &str)] = &[
  ("html", "text/html"),
  ("htm", "text/html"),
  ("xhtml", "application/xhtml+xml"),
  ("json", "application/json"),
  ("jsonl", "application/x-ndjson"),
  ("ndjson", "application/x-ndjson"),
  ("xml", "application/xml"),
  ("svg", "image/svg+xml"),
  ("rss", "application/rss+xml"),
  ("atom", "application/atom+xml"),
  ("md", "text/markdown"),
  ("markdown", "text/markdown"),
  ("txt", "text/plain"),
  ("yaml", "text/yaml"),
  ("yml", "text/yaml"),
  ("toml", "application/toml"),
  ("tsv", "text/tab-separated-values"),
  ("css", "text/css"),
  ("js", "text/javascript"),
  ("mjs", "text/javascript"),
];

/// Returns the lowercased media type of a Content-Type header without parameters.
pub(crate) fn media_type(content_type: &str) -> String {
  content_type
    .split_once(';')
    .map_or(content_type, |(mt, _)| mt)
    .trim()
    .to_ascii_lowercase()
}

pub(crate) fn document_extension_from_media_type(mt: &str) -> Option<&'static str> {
  DOCUMENT_CONTENT_TYPES
    .iter()
    .find(|(ct, _)| *ct == mt)
    .map(|(_, ext)| *ext)
}

pub(crate) fn document_content_type_for_extension(ext: &str) -> Option<&'static str> {
  let normalized = normalize_extension(ext)?;
  DOCUMENT_CONTENT_TYPES
    .iter()
    .find(|(_, mapped)| *mapped == normalized)
    .map(|(ct, _)| *ct)
}

pub(crate) fn content_type_for_anydoc_format(format: anydoc::Format) -> &'static str {
  match format {
    anydoc::Format::Doc => "application/msword",
    anydoc::Format::Docx => {
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    }
    anydoc::Format::Odt => "application/vnd.oasis.opendocument.text",
    anydoc::Format::Pdf => "application/pdf",
    anydoc::Format::Ppt => "application/vnd.ms-powerpoint",
    anydoc::Format::Pptx => {
      "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    }
    anydoc::Format::Rtf => "application/rtf",
    anydoc::Format::Epub => "application/epub+zip",
    anydoc::Format::Excel => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    anydoc::Format::Ods => "application/vnd.oasis.opendocument.spreadsheet",
    anydoc::Format::Odp => "application/vnd.oasis.opendocument.presentation",
    anydoc::Format::Csv => "text/csv",
  }
}

pub(crate) fn extension_for_anydoc_format(format: anydoc::Format) -> &'static str {
  match format {
    anydoc::Format::Doc => "doc",
    anydoc::Format::Docx => "docx",
    anydoc::Format::Odt => "odt",
    anydoc::Format::Pdf => "pdf",
    anydoc::Format::Ppt => "ppt",
    anydoc::Format::Pptx => "pptx",
    anydoc::Format::Rtf => "rtf",
    anydoc::Format::Epub => "epub",
    anydoc::Format::Excel => "xlsx",
    anydoc::Format::Ods => "ods",
    anydoc::Format::Odp => "odp",
    anydoc::Format::Csv => "csv",
  }
}

pub(crate) fn normalize_extension(raw: &str) -> Option<String> {
  let trimmed = raw.trim().trim_start_matches('.').to_ascii_lowercase();
  (!trimmed.is_empty()).then_some(trimmed)
}

pub(crate) fn extension_from_filename(filename: &str) -> Option<String> {
  let base = filename.rsplit(['/', '\\']).next().unwrap_or(filename);
  let (_, ext) = base.rsplit_once('.')?;
  normalize_extension(ext)
}

pub(crate) fn url_path(raw_url: &str) -> String {
  if let Ok(parsed) = url::Url::parse(raw_url) {
    return parsed.path().to_ascii_lowercase();
  }
  let without_fragment = raw_url.split('#').next().unwrap_or(raw_url);
  without_fragment
    .split('?')
    .next()
    .unwrap_or(without_fragment)
    .to_ascii_lowercase()
}

fn document_extension_from_url_path(raw_url: &str) -> Option<&'static str> {
  let path = url_path(raw_url);
  for ext in DOCUMENT_EXTENSIONS_BY_LENGTH {
    let dot_ext = format!(".{ext}");
    let slash_ext = format!(".{ext}/");
    if path.ends_with(&dot_ext) || path.contains(&slash_ext) {
      return Some(*ext);
    }
  }
  None
}

pub(crate) fn resolve_document_extension_hint(request: &ParseRawDocumentRequest) -> Option<String> {
  if let Some(ext) = request
    .extension_hint
    .as_deref()
    .and_then(normalize_extension)
    .filter(|e| DOCUMENT_EXTENSIONS_BY_LENGTH.contains(&e.as_str()))
  {
    return Some(ext);
  }
  if let Some(ext) = request
    .filename
    .as_deref()
    .and_then(extension_from_filename)
    .filter(|e| DOCUMENT_EXTENSIONS_BY_LENGTH.contains(&e.as_str()))
  {
    return Some(ext);
  }
  document_extension_from_url_path(&request.url).map(str::to_string)
}

pub(crate) fn is_pdf_extension_hint(request: &ParseRawDocumentRequest) -> bool {
  if request
    .extension_hint
    .as_deref()
    .and_then(normalize_extension)
    .as_deref()
    == Some("pdf")
  {
    return true;
  }
  if request
    .filename
    .as_deref()
    .and_then(extension_from_filename)
    .as_deref()
    == Some("pdf")
  {
    return true;
  }
  let path = url_path(&request.url);
  path.ends_with(".pdf") || path.contains(".pdf/")
}

fn declared_ext_matches_format(declared_ext: &str, detected: anydoc::Format) -> bool {
  match detected {
    anydoc::Format::Docx => matches!(declared_ext, "docx" | "docm"),
    anydoc::Format::Excel => matches!(declared_ext, "xlsx" | "xlsm" | "xlsb" | "xls"),
    anydoc::Format::Pptx => matches!(declared_ext, "pptx" | "pptm"),
    other => declared_ext == extension_for_anydoc_format(other),
  }
}

pub(crate) fn resolve_document_content_type(
  raw_ct: Option<&str>,
  detected: Option<anydoc::Format>,
  ext_hint: Option<&str>,
) -> String {
  let trimmed_ct = raw_ct.map(str::trim).filter(|s| !s.is_empty());
  if let Some(fmt) = detected {
    if let Some(ct) = trimmed_ct {
      let mt = media_type(ct);
      if document_extension_from_media_type(&mt)
        .is_some_and(|declared_ext| declared_ext_matches_format(declared_ext, fmt))
      {
        return ct.to_string();
      }
    }
    return content_type_for_anydoc_format(fmt).to_string();
  }
  if let Some(ct) = trimmed_ct {
    let mt = media_type(ct);
    if document_extension_from_media_type(&mt).is_some() {
      return ct.to_string();
    }
  }
  if let Some(ct) = ext_hint.and_then(document_content_type_for_extension) {
    return ct.to_string();
  }
  trimmed_ct.unwrap_or("application/octet-stream").to_string()
}

pub(crate) fn infer_text_content_type(bytes: &[u8], request: &ParseRawDocumentRequest) -> String {
  if let Some(ct) = request
    .content_type
    .as_deref()
    .map(str::trim)
    .filter(|s| !s.is_empty())
  {
    let mt = media_type(ct);
    if mt != "application/octet-stream" && mt != "binary/octet-stream" {
      return ct.to_string();
    }
  }
  let ext = request
    .extension_hint
    .as_deref()
    .and_then(normalize_extension)
    .or_else(|| {
      request
        .filename
        .as_deref()
        .and_then(extension_from_filename)
    })
    .or_else(|| {
      let path = url_path(&request.url);
      let base = path.rsplit('/').next().unwrap_or(&path);
      base
        .rsplit_once('.')
        .and_then(|(_, e)| normalize_extension(e))
    });
  if let Some(ext) = ext
    && let Some((_, ct)) = TEXT_EXTENSIONS.iter().find(|(e, _)| *e == ext)
  {
    return (*ct).to_string();
  }
  let head = bytes.get(..bytes.len().min(512)).unwrap_or(bytes);
  let decoded = match encoding_rs::Encoding::for_bom(head) {
    Some((enc, bom_len)) => enc.decode(head.get(bom_len..).unwrap_or_default()).0,
    None => String::from_utf8_lossy(head),
  };
  let start = decoded
    .trim_start_matches('﻿')
    .trim_start()
    .to_ascii_lowercase();
  if start.starts_with("<!doctype html") || start.starts_with("<html") {
    return "text/html".to_string();
  }
  if start.starts_with("<?xml") {
    return "application/xml".to_string();
  }
  "text/plain; charset=utf-8".to_string()
}
