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
  /// Pages recommended for OCR, including missing or unreliable text.
  pub pages_needing_ocr: usize,
  /// OCR pages explicitly classified as scanned images.
  pub scanned_pages: usize,
}

impl ParsedDocument {
  pub fn ocr_warning(&self) -> Option<String> {
    let mut warnings = Vec::new();
    if self.scanned_pages > 0 {
      warnings.push(format!(
        "{} page(s) of this PDF are scanned images; their text could not be extracted.",
        self.scanned_pages
      ));
    }
    let other_pages = self.pages_needing_ocr.saturating_sub(self.scanned_pages);
    if other_pages > 0 {
      warnings.push(format!(
        "{other_pages} page(s) of this PDF may have missing or unreliable text and are recommended for OCR."
      ));
    }
    if warnings.is_empty() {
      None
    } else {
      warnings.push("The local engine has no OCR.".into());
      Some(warnings.join(" "))
    }
  }
}

pub fn parse(kind: &DocKind, body: &[u8]) -> Result<ParsedDocument, String> {
  match kind {
    DocKind::Pdf => {
      let result =
        pdf_inspector::process_pdf_mem(body).map_err(|e| format!("could not read the PDF: {e}"))?;
      Ok(ParsedDocument {
        markdown: result.markdown.unwrap_or_default(),
        title: result.title.filter(|t| !t.trim().is_empty()),
        pages: Some(result.page_count),
        pages_needing_ocr: result.pages_needing_ocr.len(),
        scanned_pages: result
          .ocr_reasons_by_page
          .iter()
          .filter(|page| {
            page
              .reasons
              .iter()
              .any(|r| r == pdf_inspector::OCR_REASON_SCANNED)
          })
          .count(),
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
        scanned_pages: 0,
      })
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  // A tiny PDF with a standard font and an optional decorative image. Keep
  // fixtures generated here so the tests need no downloads or binary assets.
  fn pdf_fixture(text: &str, image: bool, broken_font: bool) -> Vec<u8> {
    let content = format!(
      "BT /F1 12 Tf 72 720 Td {text} ET {}",
      if image {
        "q 20 0 0 20 10 10 cm /Im1 Do Q"
      } else {
        ""
      }
    );
    let font = if broken_font {
      "<< /Type /Font /Subtype /Type0 /BaseFont /Unknown /Encoding /Identity-H /DescendantFonts [7 0 R] >>"
    } else {
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
    };
    let objects = [
      "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
      format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> {} >> /Contents 5 0 R >>",
        if image { "/XObject << /Im1 6 0 R >>" } else { "" }),
      font.to_string(),
      format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len()),
      "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\nx\nendstream".to_string(),
      "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Unknown /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>".to_string(),
    ];
    let mut pdf = String::from("%PDF-1.4\n");
    let mut offsets = Vec::new();
    for (i, object) in objects.iter().enumerate() {
      offsets.push(pdf.len());
      pdf.push_str(&format!("{} 0 obj\n{object}\nendobj\n", i + 1));
    }
    let xref = pdf.len();
    pdf.push_str(&format!(
      "xref\n0 {}\n0000000000 65535 f \n",
      objects.len() + 1
    ));
    for offset in offsets {
      pdf.push_str(&format!("{offset:010} 00000 n \n"));
    }
    pdf.push_str(&format!(
      "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
      objects.len() + 1
    ));
    pdf.into_bytes()
  }

  #[tokio::test]
  async fn pdf_warnings_distinguish_scans_from_unreliable_text() {
    use crate::guard::NetworkPolicy;
    use crate::scrape::{BrowserMode, Engine, EngineConfig, ScrapeOptions};
    use axum::{routing::get, Router};

    let text =
      "(This page contains readable body text alongside a small decorative logo.) Tj 0 -8 Td "
        .repeat(60);
    let readable = pdf_fixture(&text, true, false);
    let scanned = pdf_fixture("", true, false);
    let broken = pdf_fixture("<00010002000300040005> Tj", false, true);
    let app = Router::new()
      .route(
        "/readable.pdf",
        get(move || async move { ([("content-type", "application/pdf")], readable) }),
      )
      .route(
        "/scanned.pdf",
        get(move || async move { ([("content-type", "application/pdf")], scanned) }),
      )
      .route(
        "/broken.pdf",
        get(move || async move { ([("content-type", "application/pdf")], broken) }),
      );
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
      .await
      .unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let engine = Engine::new(EngineConfig {
      policy: NetworkPolicy::AllowPrivate,
      browser: BrowserMode::Never,
      user_agent: None,
    })
    .unwrap();
    let opts = ScrapeOptions::default();
    let readable = engine
      .scrape(&format!("{base}/readable.pdf"), &opts)
      .await
      .unwrap();
    assert!(readable.get("warning").is_none(), "{readable}");
    assert!(readable["markdown"]
      .as_str()
      .unwrap()
      .contains("readable body text"));
    let scanned = engine
      .scrape(&format!("{base}/scanned.pdf"), &opts)
      .await
      .unwrap();
    assert!(scanned["warning"]
      .as_str()
      .unwrap()
      .contains("1 page(s) of this PDF are scanned images"));
    let broken = engine
      .scrape(&format!("{base}/broken.pdf"), &opts)
      .await
      .unwrap();
    let warning = broken["warning"].as_str().unwrap();
    assert!(!warning.contains("scanned images"), "{warning}");
    assert!(warning.contains("unreliable text"), "{warning}");
    engine.shutdown().await;
    server.abort();
  }

  #[test]
  fn mixed_ocr_reasons_keep_separate_page_counts() {
    let doc = ParsedDocument {
      markdown: "Extracted body text".into(),
      title: None,
      pages: Some(64),
      pages_needing_ocr: 60,
      scanned_pages: 3,
    };
    let warning = doc.ocr_warning().unwrap();
    assert!(warning.starts_with("3 page(s) of this PDF are scanned images;"));
    assert!(warning.contains("57 page(s) of this PDF may have missing or unreliable text"));
    assert!(!warning.contains("60 page(s)"));
  }

  #[test]
  fn invalid_pdf_returns_a_parse_error() {
    assert!(parse(&DocKind::Pdf, b"not a PDF").is_err());
  }

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
}
