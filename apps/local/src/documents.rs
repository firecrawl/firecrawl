//! PDFs and office documents, parsed with the same libraries the cloud API
//! uses: `pdf-inspector` for PDFs and `anydoc` (through the shared
//! `document` module) for DOCX, XLSX, PPTX, ODT, RTF and friends.

use url::Url;

pub enum DocKind {
  Pdf,
  /// An office document, with the URL's file extension as a format hint.
  Office(Option<String>),
}

const OFFICE_EXTENSIONS: &[&str] = &[
  "docx", "doc", "xlsx", "xls", "pptx", "ppt", "odt", "ods", "odp", "rtf", "epub",
];

fn extension_of(url: &Url) -> Option<String> {
  let last = url.path().rsplit('/').next()?;
  let (_, ext) = last.rsplit_once('.')?;
  let ext = ext.to_ascii_lowercase();
  if ext.len() <= 5 && ext.chars().all(|c| c.is_ascii_alphanumeric()) {
    Some(ext)
  } else {
    None
  }
}

/// Decide from the first bytes, then the content type and extension, whether
/// a response is a document rather than a web page. The bytes win: servers
/// often send PDFs as `text/html` or `application/octet-stream`.
pub fn sniff(body: &[u8], mime: Option<&str>, url: &Url) -> Option<DocKind> {
  // "%PDF-" at the very start, allowing a byte-order mark or a few stray
  // bytes of whitespace before it.
  let head = &body[..body.len().min(32)];
  let skip = head
    .iter()
    .take_while(|b| b.is_ascii_whitespace() || matches!(**b, 0xEF | 0xBB | 0xBF))
    .count();
  if head[skip..].starts_with(b"%PDF-") {
    return Some(DocKind::Pdf);
  }
  let ext = extension_of(url);
  let office_ext = ext
    .as_deref()
    .map(|e| OFFICE_EXTENSIONS.contains(&e))
    .unwrap_or(false);
  let office_mime = mime
    .map(|m| {
      m.contains("officedocument")
        || m.contains("msword")
        || m.contains("ms-excel")
        || m.contains("ms-powerpoint")
        || m.contains("opendocument")
        || m == "application/rtf"
        || m == "text/rtf"
        || m == "application/epub+zip"
    })
    .unwrap_or(false);
  let zip_magic = body.starts_with(b"PK\x03\x04");
  let ole_magic = body.starts_with(&[0xD0, 0xCF, 0x11, 0xE0]);
  let rtf_magic = body.starts_with(b"{\\rtf");
  if office_mime
    || rtf_magic
    || ((zip_magic || ole_magic) && (office_ext || office_mime))
    || (office_ext && (zip_magic || ole_magic))
  {
    return Some(DocKind::Office(ext));
  }
  if mime == Some("application/pdf") {
    return Some(DocKind::Pdf);
  }
  None
}

pub struct ParsedDocument {
  pub markdown: String,
  pub title: Option<String>,
  pub pages: Option<u32>,
  /// Pages a text extraction could not read (scanned images).
  pub pages_needing_ocr: usize,
}

pub fn parse(kind: &DocKind, body: &[u8]) -> Result<ParsedDocument, String> {
  match kind {
    DocKind::Pdf => {
      let result =
        pdf_inspector::process_pdf_mem(body).map_err(|e| format!("could not read the PDF: {e}"))?;
      let markdown = crate::pdf_table_align::realign_tagged_tables(
        body,
        result.markdown.unwrap_or_default(),
        None,
      );
      Ok(ParsedDocument {
        markdown,
        title: result.title.filter(|t| !t.trim().is_empty()),
        pages: Some(result.page_count),
        pages_needing_ocr: result.pages_needing_ocr.len(),
      })
    }
    DocKind::Office(ext) => {
      let markdown = crate::document::convert_document_bytes_to_markdown(body, ext.clone())
        .map_err(|e| format!("could not read the document: {e}"))?;
      Ok(ParsedDocument {
        markdown,
        title: None,
        pages: None,
        pages_needing_ocr: 0,
      })
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn u(s: &str) -> Url {
    Url::parse(s).unwrap()
  }

  #[test]
  fn pdf_bytes_win_over_a_wrong_content_type() {
    let body = b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj";
    assert!(matches!(
      sniff(body, Some("text/html"), &u("https://x.dev/download/12")),
      Some(DocKind::Pdf)
    ));
    assert!(matches!(
      sniff(b"", Some("application/pdf"), &u("https://x.dev/a")),
      Some(DocKind::Pdf)
    ));
  }

  #[test]
  fn office_documents_by_magic_and_extension() {
    let zip = b"PK\x03\x04rest";
    assert!(
      matches!(sniff(zip, Some("application/octet-stream"), &u("https://x.dev/f/report.xlsx")), Some(DocKind::Office(Some(ref e))) if e == "xlsx")
    );
    assert!(matches!(
      sniff(
        zip,
        Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
        &u("https://x.dev/dl?id=1")
      ),
      Some(DocKind::Office(None))
    ));
    // A plain zip download is not a document.
    assert!(sniff(
      zip,
      Some("application/zip"),
      &u("https://x.dev/archive.zip")
    )
    .is_none());
  }

  #[test]
  fn web_pages_are_not_documents() {
    assert!(sniff(
      b"<!doctype html><html>",
      Some("text/html"),
      &u("https://x.dev/page.html")
    )
    .is_none());
    assert!(sniff(
      b"plain text mentioning %PDF- later on",
      Some("text/plain"),
      &u("https://x.dev/a.txt")
    )
    .is_none());
    assert!(matches!(
      sniff(
        b"\n\n%PDF-1.4",
        Some("application/octet-stream"),
        &u("https://x.dev/d")
      ),
      Some(DocKind::Pdf)
    ));
  }

  #[test]
  fn pdf_table_keeps_empty_cells_in_their_columns() {
    let pdf = include_bytes!("fixtures/empty-cells-statement.pdf");
    let parsed = parse(&DocKind::Pdf, pdf).expect("pdf parses");
    let md = parsed.markdown;
    assert!(
      md.contains("|Date|Description|Withdrawals|Deposits|Balance|"),
      "{md}"
    );
    assert!(md.contains("|10/01|LOAN PMT|2,675.12||15,777.25|"), "{md}");
    assert!(
      md.contains("|10/06|MOBILE DEPOSIT||6,146.48|17,352.24|"),
      "{md}"
    );
    assert!(!md.contains("|10/01|LOAN PMT|2,675.12|15,777.25||"), "{md}");
    assert!(
      !md.contains("|10/06|MOBILE DEPOSIT|6,146.48|17,352.24||"),
      "{md}"
    );
  }

  #[test]
  fn pdf_table_without_empty_cells_keeps_its_values() {
    let pdf = include_bytes!("fixtures/aligned-cells-statement.pdf");
    let parsed = parse(&DocKind::Pdf, pdf).expect("pdf parses");
    let md = parsed.markdown;
    assert!(md.contains("|A|B|"), "{md}");
    assert!(md.contains("|1|2|"), "{md}");
    assert!(!md.contains("|1||") && !md.contains("||2|"), "{md}");
  }

  #[test]
  fn pdf_without_a_table_is_not_rewritten_into_one() {
    let pdf = include_bytes!("fixtures/plain-sentence.pdf");
    let parsed = parse(&DocKind::Pdf, pdf).expect("pdf parses");
    let md = parsed.markdown;
    assert!(md.contains("sentence") || md.contains("tabular"), "{md}");
    assert!(!md.contains('|'), "{md}");
  }

  #[test]
  fn two_pages_keep_their_own_empty_cells() {
    let pdf = include_bytes!("fixtures/two-page-tables.pdf");
    let raw = pdf_inspector::process_pdf_mem(pdf)
      .expect("pdf parses")
      .markdown
      .unwrap_or_default();
    let capped = crate::pdf_table_align::realign_tagged_tables(pdf, raw.clone(), Some(1));
    let all = crate::pdf_table_align::realign_tagged_tables(pdf, raw, None);
    assert!(
      capped.contains("|10/01|LOAN PMT|2,675.12||15,777.25|"),
      "{capped}"
    );
    assert!(capped.contains("|A1|9||"), "{capped}");
    assert!(!capped.contains("|A1||9|"), "{capped}");
    assert!(
      all.contains("|10/01|LOAN PMT|2,675.12||15,777.25|"),
      "{all}"
    );
    assert!(all.contains("|A1||9|"), "{all}");
    assert!(!all.contains("|A1|9||"), "{all}");
  }
}
