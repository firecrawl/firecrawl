//! Unified pure-Rust raw document leaf pipeline (`parse_raw_document`).

use base64::Engine;
use firecrawl_core_types::{
  CoreNativeError, CoreParser, CoreParserKind, CorePdfParserOptions, ParseRawDocumentRequest,
  ParseRawDocumentResult,
};
use tracing::Span;

use crate::document::convert_document_bytes_to_markdown;
use crate::fallback::parse_fallback_bytes;
use crate::formats::{
  content_type_for_anydoc_format, document_extension_from_media_type, extension_for_anydoc_format,
  infer_text_content_type, media_type, resolve_document_content_type,
  resolve_document_extension_hint,
};
use crate::magic::sniff_unsupported_binary_magic;
use crate::pdf_local::parse_pdf_bytes;
use crate::sniff::{SniffOutcome, sniff_document};

fn pdf_options_from_request(request: &ParseRawDocumentRequest) -> CorePdfParserOptions {
  match request.parsers.get(CoreParserKind::Pdf) {
    Some(CoreParser::Pdf(opts)) => opts.clone(),
    _ => CorePdfParserOptions::default(),
  }
}

fn build_raw_base64_result(
  raw_bytes: &[u8],
  content_type: String,
  populate_text_fields: bool,
) -> ParseRawDocumentResult {
  let encoded = base64::engine::general_purpose::STANDARD.encode(raw_bytes);
  let (markdown, html, raw_html) = if populate_text_fields {
    (
      Some(encoded.clone()),
      Some(encoded.clone()),
      Some(encoded.clone()),
    )
  } else {
    (None, None, None)
  };

  ParseRawDocumentResult {
    parser: CoreParserKind::RawBase64,
    content_type,
    markdown,
    html,
    raw_html,
    raw_base64: Some(encoded),
    title: None,
    num_pages: None,
    total_pages: None,
    pdf_inspection: None,
    warning: None,
  }
}

fn parse_office_document(
  raw_bytes: &[u8],
  extension_hint: Option<String>,
  content_type: String,
  wants_raw_base64: bool,
) -> Result<ParseRawDocumentResult, CoreNativeError> {
  if anydoc::Format::from_bytes(raw_bytes) == Some(anydoc::Format::Pdf) {
    return Err(CoreNativeError::UnsupportedFile {
      reason: "PDF input requires the pdf parser".to_string(),
    });
  }

  let safe_ext = extension_hint.filter(|ext| !ext.eq_ignore_ascii_case("pdf"));
  let markdown = convert_document_bytes_to_markdown(raw_bytes, safe_ext).map_err(|message| {
    if message.starts_with("unsupported input:") {
      CoreNativeError::UnsupportedFile { reason: message }
    } else {
      CoreNativeError::DocumentParse {
        parser: CoreParserKind::Document,
        message,
      }
    }
  })?;

  let raw_base64 =
    wants_raw_base64.then(|| base64::engine::general_purpose::STANDARD.encode(raw_bytes));

  Ok(ParseRawDocumentResult {
    parser: CoreParserKind::Document,
    content_type,
    markdown: Some(markdown),
    html: None,
    raw_html: None,
    raw_base64,
    title: None,
    num_pages: None,
    total_pages: None,
    pdf_inspection: None,
    warning: None,
  })
}

fn raw_base64_content_type(raw_bytes: &[u8], request: &ParseRawDocumentRequest) -> String {
  if let Some(ct) = request
    .content_type
    .as_deref()
    .map(str::trim)
    .filter(|s| !s.is_empty())
  {
    return ct.to_string();
  }
  if let Some(fmt) = anydoc::Format::from_bytes(raw_bytes) {
    return content_type_for_anydoc_format(fmt).to_string();
  }
  if let Some(mime) = sniff_unsupported_binary_magic(raw_bytes) {
    return mime.to_string();
  }
  "application/octet-stream".to_string()
}

fn dispatch_override(
  override_kind: CoreParserKind,
  raw_bytes: &[u8],
  request: &ParseRawDocumentRequest,
  wants_raw_base64: bool,
) -> Result<ParseRawDocumentResult, CoreNativeError> {
  match override_kind {
    CoreParserKind::Pdf => {
      let opts = pdf_options_from_request(request);
      parse_pdf_bytes(raw_bytes, &opts, wants_raw_base64)
    }
    CoreParserKind::Document => {
      let detected = anydoc::Format::from_bytes(raw_bytes).filter(|f| *f != anydoc::Format::Pdf);
      let mt = request
        .content_type
        .as_deref()
        .map(media_type)
        .unwrap_or_default();
      let ext = detected
        .map(|f| extension_for_anydoc_format(f).to_string())
        .or_else(|| document_extension_from_media_type(&mt).map(str::to_string))
        .or_else(|| resolve_document_extension_hint(request));
      let content_type =
        resolve_document_content_type(request.content_type.as_deref(), detected, ext.as_deref());
      parse_office_document(raw_bytes, ext, content_type, wants_raw_base64)
    }
    CoreParserKind::Fallback => {
      let content_type = infer_text_content_type(raw_bytes, request);
      Ok(parse_fallback_bytes(
        raw_bytes,
        content_type,
        wants_raw_base64,
      ))
    }
    CoreParserKind::RawBase64 => {
      let content_type = raw_base64_content_type(raw_bytes, request);
      Ok(build_raw_base64_result(raw_bytes, content_type, false))
    }
  }
}

/// Sniffs magic bytes, Content-Type, and filename/extension hints, enforces
/// `maxFileSizeBytes`, and parses raw document bytes through the open-source
/// local parser pipeline (`pdf`, `document`, `fallback`, or `rawBase64`).
#[tracing::instrument(
  name = "firecrawl_parsers::parse_raw_document",
  skip(raw_bytes, request),
  fields(
    parser = tracing::field::Empty,
    parser.signal = tracing::field::Empty,
    raw_bytes.len = raw_bytes.len(),
  ),
  err
)]
pub fn parse_raw_document(
  raw_bytes: &[u8],
  request: &ParseRawDocumentRequest,
) -> Result<ParseRawDocumentResult, CoreNativeError> {
  if let Some(limit) = request.max_file_size_bytes {
    let actual = u64::try_from(raw_bytes.len()).unwrap_or(u64::MAX);
    if actual > limit {
      return Err(CoreNativeError::UnsupportedFile {
        reason: format!("File exceeds size limit ({actual} > {limit} bytes)"),
      });
    }
  }

  let wants_raw_base64 =
    request.include_raw_base64 || request.parsers.contains(CoreParserKind::RawBase64);
  let span = Span::current();

  if let Some(override_kind) = request.parser_override {
    span.record("parser", override_kind.to_string().as_str());
    span.record("parser.signal", "override");
    return dispatch_override(override_kind, raw_bytes, request, wants_raw_base64);
  }

  if request.parsers.len() == 1 && request.parsers.contains(CoreParserKind::RawBase64) {
    span.record("parser", "rawBase64");
    span.record("parser.signal", "parsers");
    let content_type = raw_base64_content_type(raw_bytes, request);
    return Ok(build_raw_base64_result(raw_bytes, content_type, false));
  }

  match sniff_document(raw_bytes, request) {
    SniffOutcome::Pdf { signal } => {
      span.record("parser.signal", signal);
      if !request.parsers.contains(CoreParserKind::Pdf) {
        span.record("parser", "rawBase64");
        return Ok(build_raw_base64_result(
          raw_bytes,
          "application/pdf".to_string(),
          true,
        ));
      }
      span.record("parser", "pdf");
      let opts = pdf_options_from_request(request);
      parse_pdf_bytes(raw_bytes, &opts, wants_raw_base64)
    }
    SniffOutcome::Document {
      signal,
      extension_hint,
      content_type,
    } => {
      span.record("parser", "document");
      span.record("parser.signal", signal);
      parse_office_document(raw_bytes, extension_hint, content_type, wants_raw_base64)
    }
    SniffOutcome::UnsupportedBinary { reason } => {
      span.record("parser.signal", "unsupported_binary");
      if wants_raw_base64 {
        span.record("parser", "rawBase64");
        return Ok(build_raw_base64_result(raw_bytes, reason, false));
      }
      span.record("parser", "unsupported");
      Err(CoreNativeError::UnsupportedFile { reason })
    }
    SniffOutcome::Fallback {
      signal,
      content_type,
    } => {
      span.record("parser", "fallback");
      span.record("parser.signal", signal);
      Ok(parse_fallback_bytes(
        raw_bytes,
        content_type,
        wants_raw_base64,
      ))
    }
  }
}
