use base64::Engine;
use encoding_rs::Encoding;
use firecrawl_core_types::{
  CoreNativeError, CoreNativeFailure, CoreParser, CoreParserKind, CoreParsers, CorePdfMode,
  CorePdfParserOptions, ParseRawDocumentRequest,
};
use hegel::{
  TestCase,
  generators::{self as gs, Generator},
};

use crate::parse_raw_document;

mod contracts;
mod office;

const URLS: &[&str] = &[
  "https://example.com/file",
  "https://example.com/report.pdf",
  "https://example.com/doc.docx",
  "https://example.com/sheet.xlsx",
  "https://example.com/deck.pptx",
  "https://example.com/notes.odt",
  "https://example.com/letter.rtf",
  "https://example.com/data.csv",
  "https://example.com/page.html",
  "https://example.com/api.json",
  "https://example.com/archive.zip",
  "https://example.com/file.xlsx/hash?dl=1",
  "not-a-valid-url",
];

const CONTENT_TYPES: &[&str] = &[
  "text/html",
  "text/html; charset=utf-8",
  "text/html; charset=\"gb18030\"",
  "text/html; charset=x-user-defined",
  "text/html; charset=",
  "text/html;charset=utf-16le;charset=latin1",
  "application/pdf",
  "APPLICATION/PDF; name=a.pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-excel",
  "application/msword",
  "application/rtf",
  "text/rtf",
  "application/vnd.oasis.opendocument.text",
  "text/csv",
  "application/json",
  "text/plain",
  "application/zip",
  "image/png",
  "video/mp4",
  "application/wasm",
  "application/octet-stream",
  "",
  ";;;",
];

const FILENAMES: &[&str] = &[
  "a.pdf", "a.docx", "a.doc", "a.odt", "a.rtf", "a.xlsx", "a.xls", "a.pptx", "a.csv", "a.html",
  "a.zip", "a.png", ".pdf", "",
];

const EXTENSIONS: &[&str] = &[
  ".pdf", "pdf", ".docx", "xlsx", "pptx", "rtf", "odt", "csv", "txt", "bin", "",
];

const CHARSETS: &[&str] = &[
  "utf-8",
  "shift_jis",
  "euc-kr",
  "gb18030",
  "big5",
  "iso-8859-1",
  "windows-1252",
  "koi8-r",
  "utf-16le",
  "x-user-defined",
  "replacement",
  "bogus",
];

const PDF_OBJECTS: &[&str] = &[
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count {n} >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {n} {n}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
  "stream:BT /F1 {n} Tf {n} {n} Td ({text}) Tj ET",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  "<< /Title ({text}) /Author <FEFF00{n}> >>",
];

const PDF_MUTATIONS: &[&str] = &[
  "stream:{text}",
  "<< /Length {n} /Filter /FlateDecode >>\nstream\n{text}\nendstream",
  "<< /Type /Font /Subtype /Type0 /Encoding /Identity-H /ToUnicode {n} 0 R >>",
  "<< /Type /XObject /Subtype /Image /Width {n} /Height {n} /BitsPerComponent 8 >>",
  "[{n} 0 R {n} 0 R]",
  "{text}",
];

#[hegel::composite]
fn pdf_object(tc: &TestCase, template: &'static str) -> String {
  let mut object = template.replace("{text}", &tc.draw(gs::text().max_size(32)));
  while object.contains("{n}") {
    let n = tc.draw(hegel::one_of!(
      gs::integers::<i64>().min_value(-2).max_value(1024),
      gs::integers::<i64>(),
    ));
    object = object.replacen("{n}", &n.to_string(), 1);
  }
  match object.strip_prefix("stream:") {
    Some(content) => format!(
      "<< /Length {} >>\nstream\n{content}\nendstream",
      content.len()
    ),
    None => object,
  }
}

#[hegel::composite]
fn pdf_body(tc: &TestCase) -> Vec<u8> {
  let mut pdf = format!("%PDF-1.{}\n", tc.draw(gs::integers::<u8>().max_value(9))).into_bytes();
  let mut offsets = Vec::new();
  for template in PDF_OBJECTS {
    let chosen = if tc.draw(gs::weighted_booleans(0.15)) {
      tc.draw(gs::sampled_from(PDF_MUTATIONS))
    } else {
      *template
    };
    let object = tc.draw(pdf_object(chosen));
    offsets.push(pdf.len());
    pdf.extend(format!("{} 0 obj\n{object}\nendobj\n", offsets.len()).bytes());
  }
  let xref = pdf.len();
  let size = offsets.len().saturating_add(1);
  pdf.extend(format!("xref\n0 {size}\n0000000000 65535 f \n").bytes());
  for offset in &offsets {
    let chosen_offset = if tc.draw(gs::weighted_booleans(0.9)) {
      *offset
    } else {
      tc.draw(gs::integers::<usize>().max_value(99_999))
    };
    pdf.extend(format!("{chosen_offset:010} 00000 n \n").bytes());
  }
  pdf.extend(
    format!("trailer\n<< /Size {size} /Root 1 0 R /Info 6 0 R >>\nstartxref\n{xref}\n%%EOF\n")
      .bytes(),
  );
  if tc.draw(gs::weighted_booleans(0.15)) {
    pdf.truncate(tc.draw(gs::integers::<usize>().max_value(pdf.len())));
  }
  pdf
}

#[hegel::composite]
fn rtf_body(tc: &TestCase) -> Vec<u8> {
  let words = tc.draw(
    gs::vecs(hegel::one_of!(
      gs::sampled_from(&[
        "\\par ",
        "\\b ",
        "\\b0 ",
        "\\u-3913?",
        "\\'e9",
        "{",
        "}",
        "\\*\\generator x;",
        "{\\fonttbl{\\f0 Times;}}",
        "\\bin4 ",
        "\\pict ",
        "\\tab ",
        "\\uc0 ",
      ])
      .map(str::to_string),
      gs::text().max_size(16),
    ))
    .max_size(12),
  );
  format!("{{\\rtf1\\ansi\\deff0 {}}}", words.concat()).into_bytes()
}

#[hegel::composite]
fn html_body(tc: &TestCase) -> Vec<u8> {
  let charset = tc.draw(gs::sampled_from(CHARSETS));
  let text = tc.draw(gs::text().max_size(64));
  let html =
    format!("<html><head><meta charset=\"{charset}\"></head><body><p>{text}</p></body></html>");
  Encoding::for_label(charset.as_bytes()).map_or_else(
    || html.clone().into_bytes(),
    |enc| enc.encode(&html).0.into_owned(),
  )
}

#[hegel::composite]
fn arbitrary_body(tc: &TestCase) -> Vec<u8> {
  let magic: &[u8] = match tc.draw(gs::integers::<u8>().max_value(11)) {
    0 => return tc.draw(pdf_body()),
    1 => return tc.draw(office::zip_body()),
    2 => return tc.draw(rtf_body()),
    3 => return tc.draw(html_body()),
    4 => return Vec::new(),
    5 => {
      let pad = tc.draw(gs::integers::<usize>().min_value(1024).max_value(2048));
      let mut buf = vec![b' '; pad];
      buf.extend_from_slice(b"%PDF-1.7\n");
      buf.extend(tc.draw(gs::binary().max_size(64)));
      return buf;
    }
    6 => b"PK\x03\x04",
    7 => &[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1],
    8 => b"%PDF-1.7\n",
    9 => b"\x89PNG\r\n\x1a\n",
    10 => b"\x00asm",
    _ => b"",
  };
  [magic, &tc.draw(gs::binary().max_size(512))].concat()
}

#[hegel::composite]
fn arbitrary_parsers(tc: &TestCase) -> CoreParsers {
  let mut set = CoreParsers::new();
  if tc.draw(gs::weighted_booleans(0.7)) {
    let mode = tc.draw(gs::optional(gs::sampled_from(&[
      CorePdfMode::Auto,
      CorePdfMode::Fast,
    ])));
    let max_pages = tc.draw(gs::optional(
      gs::integers::<u32>().min_value(1).max_value(10_000),
    ));
    set.insert(CoreParser::Pdf(CorePdfParserOptions { mode, max_pages }));
  }
  if tc.draw(gs::weighted_booleans(0.25)) {
    set.insert(CoreParser::Document);
  }
  if tc.draw(gs::weighted_booleans(0.25)) {
    set.insert(CoreParser::Fallback);
  }
  if tc.draw(gs::weighted_booleans(0.25)) {
    set.insert(CoreParser::RawBase64);
  }
  set
}

#[hegel::composite]
fn arbitrary_request(tc: &TestCase) -> ParseRawDocumentRequest {
  let url = tc.draw(hegel::one_of!(
    gs::sampled_from(URLS).map(str::to_string),
    gs::text().max_size(48),
  ));
  let content_type = tc.draw(gs::optional(hegel::one_of!(
    gs::sampled_from(CONTENT_TYPES).map(str::to_string),
    gs::text().max_size(32),
  )));
  let filename = tc.draw(gs::optional(hegel::one_of!(
    gs::sampled_from(FILENAMES).map(str::to_string),
    gs::text().max_size(24),
  )));
  let extension_hint = tc.draw(gs::optional(hegel::one_of!(
    gs::sampled_from(EXTENSIONS).map(str::to_string),
    gs::text().max_size(12),
  )));
  let parser_override = tc.draw(gs::optional(gs::sampled_from(&[
    CoreParserKind::Pdf,
    CoreParserKind::Document,
    CoreParserKind::Fallback,
    CoreParserKind::RawBase64,
  ])));
  let max_file_size_bytes = tc.draw(gs::optional(hegel::one_of!(
    gs::integers::<u64>().max_value(1024),
    gs::integers::<u64>(),
  )));

  ParseRawDocumentRequest {
    url,
    content_type,
    filename,
    extension_hint,
    parsers: tc.draw(arbitrary_parsers()),
    include_raw_base64: tc.draw(gs::booleans()),
    max_file_size_bytes,
    parser_override,
  }
}

/// Arbitrary raw bytes (including truncated ZIPs, corrupted PDFs, random magic
/// headers, empty buffers, and huge headers) paired with arbitrary
/// `ParseRawDocumentRequest` values never panic and always uphold size limits,
/// `rawBase64` fidelity, and structured `CoreNativeError` transport contracts.
#[hegel::test]
fn parse_raw_document_never_panics_on_arbitrary_inputs(tc: TestCase) {
  let bytes = tc.draw(arbitrary_body());
  let request = tc.draw(arbitrary_request());
  let byte_len = u64::try_from(bytes.len()).unwrap_or(u64::MAX);

  let outcome = parse_raw_document(&bytes, &request);

  if let Some(limit) = request.max_file_size_bytes
    && byte_len > limit
  {
    assert!(
      matches!(outcome, Err(CoreNativeError::UnsupportedFile { .. })),
      "oversized payload ({byte_len} > {limit}) must fail with UnsupportedFile, got {outcome:?}"
    );
    return;
  }

  match outcome {
    Ok(result) => {
      assert!(!result.content_type.is_empty());
      let expects_b64 = request.include_raw_base64
        || request.parsers.contains(CoreParserKind::RawBase64)
        || request.parser_override == Some(CoreParserKind::RawBase64);
      if expects_b64 {
        let decoded = result.raw_base64.as_deref().and_then(|encoded| {
          base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .ok()
        });
        assert_eq!(decoded.as_deref(), Some(bytes.as_slice()));
      }
      if result.parser == CoreParserKind::Pdf {
        assert!(result.pdf_inspection.is_some());
        if let (Some(num), Some(total)) = (result.num_pages, result.total_pages) {
          assert!(num <= total);
        }
      }
    }
    Err(err) => {
      assert!(!matches!(err, CoreNativeError::Panic { .. }));
      let wire = err.to_transport_string();
      let decoded = CoreNativeFailure::from_transport_string(&wire).map(CoreNativeError::from);
      assert_eq!(decoded, Some(err));
    }
  }
}

/// Truncated and bit-flipped container payloads (OOXML/ODF ZIPs, PDFs, RTFs,
/// OLE2 headers) never panic across auto-sniffing and explicit parser overrides.
#[hegel::test]
fn parse_raw_document_handles_truncated_and_corrupted_containers(tc: TestCase) {
  let mut bytes = match tc.draw(gs::integers::<u8>().max_value(3)) {
    0 => tc.draw(office::zip_body()),
    1 => tc.draw(pdf_body()),
    2 => tc.draw(rtf_body()),
    _ => [
      &[0xD0u8, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1][..],
      &tc.draw(gs::binary().max_size(256)),
    ]
    .concat(),
  };

  let cut = tc.draw(gs::integers::<usize>().max_value(bytes.len()));
  bytes.truncate(cut);
  if !bytes.is_empty() && tc.draw(gs::booleans()) {
    let idx = tc.draw(gs::integers::<usize>().max_value(bytes.len().saturating_sub(1)));
    let mask = tc.draw(gs::integers::<u8>());
    if let Some(slot) = bytes.get_mut(idx) {
      *slot ^= mask;
    }
  }

  let parser_override = tc.draw(gs::optional(gs::sampled_from(&[
    CoreParserKind::Pdf,
    CoreParserKind::Document,
    CoreParserKind::Fallback,
    CoreParserKind::RawBase64,
  ])));
  let request = ParseRawDocumentRequest {
    url: "https://example.com/corrupt.docx".to_string(),
    content_type: tc.draw(gs::optional(
      gs::sampled_from(CONTENT_TYPES).map(str::to_string),
    )),
    filename: tc.draw(gs::optional(
      gs::sampled_from(FILENAMES).map(str::to_string),
    )),
    extension_hint: tc.draw(gs::optional(
      gs::sampled_from(EXTENSIONS).map(str::to_string),
    )),
    parsers: CoreParsers::default(),
    include_raw_base64: tc.draw(gs::booleans()),
    max_file_size_bytes: None,
    parser_override,
  };

  if let Err(err) = parse_raw_document(&bytes, &request) {
    assert!(!matches!(err, CoreNativeError::Panic { .. }));
    let wire = err.to_transport_string();
    assert_eq!(
      CoreNativeFailure::from_transport_string(&wire).map(CoreNativeError::from),
      Some(err)
    );
  }
}
