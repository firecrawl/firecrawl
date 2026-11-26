use base64::Engine;
use firecrawl_core_types::{
  CoreNativeError, CoreParser, CoreParserKind, CoreParsers, CorePdfMode, CorePdfParserOptions,
  ParseRawDocumentRequest,
};
use hegel::{TestCase, generators as gs};

use crate::parse_raw_document;

const MISLEADING_CONTENT_TYPES: &[Option<&str>] = &[
  None,
  Some(""),
  Some("application/octet-stream"),
  Some("text/plain"),
  Some("text/html"),
  Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
];

const MISLEADING_URLS: &[&str] = &[
  "https://example.com/blob",
  "https://example.com/report.txt",
  "https://example.com/page.html",
  "https://example.com/file.docx",
];

fn make_request(
  url: &str,
  content_type: Option<&str>,
  parsers: CoreParsers,
) -> ParseRawDocumentRequest {
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

fn pdf_parsers(mode: Option<CorePdfMode>, max_pages: Option<u32>) -> CoreParsers {
  let mut set = CoreParsers::new();
  set.insert(CoreParser::Pdf(CorePdfParserOptions { mode, max_pages }));
  set
}

fn build_pdf(pages: &[Option<&str>]) -> Vec<u8> {
  let mut out = Vec::from(b"%PDF-1.4\n".as_slice());
  let mut offsets: Vec<usize> = vec![0];
  let kids: Vec<String> = (0..pages.len())
    .map(|i| format!("{} 0 R", 4usize.saturating_add(i.saturating_mul(2))))
    .collect();
  let mut push_obj = |id: usize, body: &str| {
    offsets.push(out.len());
    out.extend_from_slice(format!("{id} 0 obj\n{body}\nendobj\n").as_bytes());
  };
  push_obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  push_obj(
    2,
    &format!(
      "<< /Type /Pages /Kids [{}] /Count {} >>",
      kids.join(" "),
      pages.len()
    ),
  );
  push_obj(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (i, text) in pages.iter().enumerate() {
    let page_id = 4usize.saturating_add(i.saturating_mul(2));
    let stream_id = page_id.saturating_add(1);
    let stream = match text {
      Some(t) => format!("BT /F1 12 Tf 72 720 Td ({t}) Tj ET"),
      None => String::new(),
    };
    push_obj(
      page_id,
      &format!(
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {stream_id} 0 R /Resources << /Font << /F1 3 0 R >> >> >>"
      ),
    );
    push_obj(
      stream_id,
      &format!(
        "<< /Length {} >>\nstream\n{stream}\nendstream",
        stream.len()
      ),
    );
  }
  let xref_pos = out.len();
  out.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", offsets.len()).as_bytes());
  for offset in offsets.iter().skip(1) {
    out.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
  }
  out.extend_from_slice(
    format!(
      "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n",
      offsets.len()
    )
    .as_bytes(),
  );
  out
}

use super::office::valid_docx;

fn ascii_word(tc: &TestCase) -> String {
  let len: usize = tc.draw(gs::integers().min_value(4).max_value(24));
  let mut out = String::with_capacity(len);
  for _ in 0..len {
    let byte: u8 = tc.draw(gs::integers().min_value(b'a').max_value(b'z'));
    out.push(char::from(byte));
  }
  out
}

#[hegel::test]
fn magic_bytes_override_misleading_headers_and_extensions(tc: TestCase) {
  let ct = tc.draw(gs::sampled_from(MISLEADING_CONTENT_TYPES.to_vec()));
  let url = tc.draw(gs::sampled_from(MISLEADING_URLS.to_vec()));
  let kind: u8 = tc.draw(gs::integers().min_value(0).max_value(3));

  match kind {
    0 => {
      let token = ascii_word(&tc);
      let line = format!("Hello {token} document");
      let bytes = build_pdf(&[Some(&line)]);
      let req = make_request(url, ct, CoreParsers::default());
      let res = parse_raw_document(&bytes, &req);
      assert!(res.is_ok(), "valid PDF should parse: {res:?}");
      if let Ok(parsed) = res {
        assert_eq!(parsed.parser, CoreParserKind::Pdf);
        assert_eq!(parsed.content_type, "application/pdf");
        assert!(parsed.pdf_inspection.is_some());
        assert!(
          parsed
            .markdown
            .as_deref()
            .is_some_and(|md| md.contains(&token))
        );
      }
    }
    1 => {
      let token = ascii_word(&tc);
      let bytes = valid_docx(&token);
      let req = make_request(url, ct, CoreParsers::default());
      let res = parse_raw_document(&bytes, &req);
      assert!(res.is_ok(), "valid DOCX should parse: {res:?}");
      if let Ok(parsed) = res {
        assert_eq!(parsed.parser, CoreParserKind::Document);
        assert!(
          parsed
            .markdown
            .as_deref()
            .is_some_and(|md| md.contains(&token))
        );
      }
    }
    2 => {
      let token = ascii_word(&tc);
      let bytes = format!(r"{{\rtf1\ansi\deff0 {token}}}").into_bytes();
      let req = make_request(url, ct, CoreParsers::default());
      let res = parse_raw_document(&bytes, &req);
      assert!(res.is_ok(), "valid RTF should parse: {res:?}");
      if let Ok(parsed) = res {
        assert_eq!(parsed.parser, CoreParserKind::Document);
        assert!(
          parsed
            .markdown
            .as_deref()
            .is_some_and(|md| md.contains(&token))
        );
      }
    }
    _ => {
      const MAGICS: &[&[u8]] = &[
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR",
        b"\xFF\xD8\xFF\xE0\x00\x10JFIF",
        b"GIF89a\x01\x00\x01\x00",
        b"\x7FELF\x02\x01\x01\x00",
        b"\x00asm\x01\x00\x00\x00",
        b"\x1F\x8B\x08\x00\x00\x00\x00\x00",
        b"SQLite format 3\x00",
      ];
      let magic = tc.draw(gs::sampled_from(MAGICS.to_vec()));
      let mut bytes = magic.to_vec();
      let tail: Vec<u8> = tc.draw(gs::vecs(gs::integers::<u8>()).max_size(32));
      bytes.extend_from_slice(&tail);
      let binary_ct = tc.draw(gs::sampled_from(vec![
        None,
        Some("application/octet-stream"),
      ]));
      let req = make_request(
        "https://example.com/asset",
        binary_ct,
        CoreParsers::default(),
      );
      let err = parse_raw_document(&bytes, &req);
      assert!(
        matches!(err, Err(CoreNativeError::UnsupportedFile { .. })),
        "unsupported binary magic must fail with UnsupportedFile, got: {err:?}"
      );
    }
  }
}

#[hegel::test]
fn pdf_max_pages_mode_and_disabled_parser_contracts(tc: TestCase) {
  let mode_case: u8 = tc.draw(gs::integers().min_value(0).max_value(2));
  match mode_case {
    0 => {
      let line = format!("Page one {}", ascii_word(&tc));
      let bytes = build_pdf(&[Some(&line)]);
      let req = make_request(
        "https://example.com/doc.pdf",
        Some("application/pdf"),
        CoreParsers::new(),
      );
      let res = parse_raw_document(&bytes, &req);
      assert!(res.is_ok());
      if let Ok(parsed) = res {
        assert_eq!(parsed.parser, CoreParserKind::RawBase64);
        assert!(parsed.pdf_inspection.is_none());
        let decoded = parsed
          .raw_base64
          .as_deref()
          .and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());
        assert_eq!(decoded.as_deref(), Some(bytes.as_slice()));
      }
    }
    1 => {
      let page_count: usize = tc.draw(gs::integers().min_value(1).max_value(5));
      let owned: Vec<String> = (1..=page_count)
        .map(|n| format!("PageMarker{n} {}", ascii_word(&tc)))
        .collect();
      let refs: Vec<Option<&str>> = owned.iter().map(|s| Some(s.as_str())).collect();
      let bytes = build_pdf(&refs);
      let max_pages: u32 = tc.draw(gs::integers().min_value(1).max_value(6));
      let req = make_request(
        "https://example.com/report.pdf",
        Some("application/pdf"),
        pdf_parsers(Some(CorePdfMode::Auto), Some(max_pages)),
      );
      let res = parse_raw_document(&bytes, &req);
      assert!(res.is_ok(), "multi-page PDF should parse: {res:?}");
      if let Ok(parsed) = res {
        let total = u32::try_from(page_count).unwrap_or(u32::MAX);
        assert_eq!(parsed.parser, CoreParserKind::Pdf);
        assert_eq!(parsed.total_pages, Some(total));
        assert_eq!(parsed.num_pages, Some(total.min(max_pages)));
        assert_eq!(
          parsed.pdf_inspection.as_ref().map(|i| i.page_count),
          Some(total)
        );
      }
    }
    _ => {
      let pages: usize = tc.draw(gs::integers().min_value(1).max_value(3));
      let empty: Vec<Option<&str>> = vec![None; pages];
      let bytes = build_pdf(&empty);
      let fast_req = make_request(
        "https://example.com/scan.pdf",
        Some("application/pdf"),
        pdf_parsers(Some(CorePdfMode::Fast), None),
      );
      assert!(matches!(
        parse_raw_document(&bytes, &fast_req),
        Err(CoreNativeError::PdfOcrRequired { .. })
      ));

      let auto_req = make_request(
        "https://example.com/scan.pdf",
        Some("application/pdf"),
        pdf_parsers(Some(CorePdfMode::Auto), None),
      );
      let auto_res = parse_raw_document(&bytes, &auto_req);
      assert!(auto_res.is_ok());
      if let Ok(parsed) = auto_res {
        assert_eq!(parsed.parser, CoreParserKind::Pdf);
        assert!(parsed.pdf_inspection.is_some());
        assert!(parsed.warning.is_some());
      }
    }
  }
}

#[hegel::test]
fn fallback_charset_and_bom_decoding_preserves_ascii_text(tc: TestCase) {
  let payload = ascii_word(&tc);
  let variant: u8 = tc.draw(gs::integers().min_value(0).max_value(3));
  let (bytes, content_type): (Vec<u8>, &str) = match variant {
    0 => {
      let mut out = vec![0xEF, 0xBB, 0xBF];
      out.extend_from_slice(payload.as_bytes());
      (out, "text/plain")
    }
    1 => {
      let mut out = vec![0xFF, 0xFE];
      for unit in payload.encode_utf16() {
        out.extend_from_slice(&unit.to_le_bytes());
      }
      (out, "text/plain")
    }
    2 => {
      let mut out = vec![0xFE, 0xFF];
      for unit in payload.encode_utf16() {
        out.extend_from_slice(&unit.to_be_bytes());
      }
      (out, "text/plain")
    }
    _ => (
      format!(r#"<!doctype html><meta charset="windows-1252"><p>{payload}</p>"#).into_bytes(),
      "text/html",
    ),
  };

  let req = make_request(
    "https://example.com/note",
    Some(content_type),
    CoreParsers::default(),
  );
  let res = parse_raw_document(&bytes, &req);
  assert!(res.is_ok());
  if let Ok(parsed) = res {
    assert_eq!(parsed.parser, CoreParserKind::Fallback);
    if variant < 3 {
      assert_eq!(parsed.markdown.as_deref(), Some(payload.as_str()));
      assert_eq!(parsed.raw_html.as_deref(), Some(payload.as_str()));
    } else {
      assert!(parsed.markdown.is_none());
      assert!(
        parsed
          .raw_html
          .as_deref()
          .is_some_and(|html| html.contains(&payload))
      );
    }
  }
}
