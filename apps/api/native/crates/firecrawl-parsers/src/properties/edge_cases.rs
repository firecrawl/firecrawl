use firecrawl_core_types::{
  CoreNativeError, CoreParser, CoreParserKind, CoreParsers, ParseRawDocumentRequest,
};

use super::office::valid_docx;
use crate::parse_raw_document;

fn req(url: &str, content_type: Option<&str>, parsers: CoreParsers) -> ParseRawDocumentRequest {
  ParseRawDocumentRequest {
    url: url.to_string(),
    content_type: content_type.map(str::to_string),
    filename: None,
    extension_hint: None,
    parsers,
    include_raw_base64: false,
    max_file_size_bytes: None,
    parser_override: None,
  }
}

#[test]
fn docx_served_as_application_zip_or_conflicting_mime_resolves_to_docx() {
  let bytes = valid_docx("Quarterly Summary");
  let expected_ct = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  for declared in [
    "application/zip",
    "application/msword",
    "application/octet-stream",
  ] {
    let res = parse_raw_document(
      &bytes,
      &req(
        "https://example.com/download",
        Some(declared),
        CoreParsers::default(),
      ),
    );
    assert!(res.is_ok(), "DOCX under {declared} should parse: {res:?}");
    if let Ok(parsed) = res {
      assert_eq!(parsed.parser, CoreParserKind::Document);
      assert_eq!(parsed.content_type, expected_ct);
      assert!(
        parsed
          .markdown
          .as_deref()
          .is_some_and(|m| m.contains("Quarterly Summary"))
      );
    }
  }
}

#[test]
fn magic_beats_mislabeled_headers_and_raw_base64_sniffs_bytes() {
  let png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR";
  for declared in ["application/pdf", "application/msword", "text/plain"] {
    let err = parse_raw_document(
      png,
      &req(
        "https://example.com/f",
        Some(declared),
        CoreParsers::default(),
      ),
    );
    assert_eq!(
      err,
      Err(CoreNativeError::UnsupportedFile {
        reason: "image/png".to_string()
      })
    );
  }

  let mut b64_only = CoreParsers::new();
  b64_only.insert(CoreParser::RawBase64);
  let pdf_bytes = b"%PDF-1.4\n%body";
  let res = parse_raw_document(
    pdf_bytes,
    &req("https://example.com/file", Some("text/plain"), b64_only),
  );
  assert!(res.is_ok());
  if let Ok(parsed) = res {
    assert_eq!(parsed.parser, CoreParserKind::RawBase64);
    assert_eq!(parsed.content_type, "application/pdf");
  }
}

#[test]
fn iso_bmff_ebml_and_id3_magic_classification() {
  let cases: &[(&[u8], &str)] = &[
    (
      b"\x00\x00\x00\x18ftypqt  \x00\x00\x00\x00",
      "video/quicktime",
    ),
    (b"\x00\x00\x00\x18ftypM4A \x00\x00\x00\x00", "audio/mp4"),
    (b"\x00\x00\x00\x18ftyp3gp5\x00\x00\x00\x00", "video/3gpp"),
    (b"\x00\x00\x00\x18ftypisom\x00\x00\x00\x00", "video/mp4"),
    (
      b"\x00\x00\x00\x18ftypunkn\x00\x00\x00\x00",
      "application/octet-stream",
    ),
    (b"\x1A\x45\xDF\xA3\x9F\x42\x82\x84webm", "video/webm"),
    (
      b"\x1A\x45\xDF\xA3\x9F\x42\x82\x88matroska",
      "video/x-matroska",
    ),
    (
      b"\x1A\x45\xDF\xA3\x9F\x01\x02\x03",
      "application/octet-stream",
    ),
    (b"ID3\x03\x00\x00\x00\x00\x00\x10", "audio/mpeg"),
  ];
  for (bytes, expected) in cases {
    let err = parse_raw_document(
      bytes,
      &req("https://example.com/media", None, CoreParsers::default()),
    );
    assert_eq!(
      err,
      Err(CoreNativeError::UnsupportedFile {
        reason: (*expected).to_string()
      })
    );
  }

  // Plain ASCII text starting with "ID3" (invalid ID3v2 major version) stays Fallback.
  let id3_text = b"ID39990000 plain text record";
  let res = parse_raw_document(
    id3_text,
    &req("https://example.com/log", None, CoreParsers::default()),
  );
  assert!(res.is_ok());
  if let Ok(parsed) = res {
    assert_eq!(parsed.parser, CoreParserKind::Fallback);
  }
}

#[test]
fn fallback_bom_html_under_octet_stream_and_meta_charset_restricted_to_html() {
  let mut bom_html = vec![0xEF, 0xBB, 0xBF];
  bom_html.extend_from_slice(b"<!doctype html><html><body>hi</body></html>");
  let res = parse_raw_document(
    &bom_html,
    &req(
      "https://example.com/page",
      Some("application/octet-stream"),
      CoreParsers::default(),
    ),
  );
  assert!(res.is_ok());
  if let Ok(parsed) = res {
    assert_eq!(parsed.parser, CoreParserKind::Fallback);
    assert_eq!(parsed.content_type, "text/html");
    assert!(parsed.markdown.is_none());
  }

  // Literal <meta charset=...> inside JSON must not override UTF-8 decoding.
  let json_bytes = r#"{"snippet":"<meta charset=\"utf-16le\">","name":"café"}"#.as_bytes();
  let json_res = parse_raw_document(
    json_bytes,
    &req(
      "https://example.com/data.json",
      Some("application/json"),
      CoreParsers::default(),
    ),
  );
  assert!(json_res.is_ok());
  if let Ok(parsed) = json_res {
    assert_eq!(parsed.parser, CoreParserKind::Fallback);
    assert!(
      parsed
        .raw_html
        .as_deref()
        .is_some_and(|s| s.contains("café"))
    );
  }
}
