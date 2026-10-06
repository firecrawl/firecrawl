//! The local pdf-inspector pass, and the text-only fallback when nothing else produced output.

use bytes::Bytes;
use pdf_inspector::PdfType;
use tracing::{Span, field::Empty};

use super::{
  super::super::error::ScrapeURLError,
  inspector::{InspectPass, inspect_pdf},
  limits::Eligibility,
  output::Parsed,
  types::{PdfMode, PdfOptions},
};

pub struct LocalPass {
  pass: InspectPass,
  /// Pages to process, capped by `maxPages`; 0 when pdf-inspector could not count them.
  pub effective_page_count: u32,
  pub total_page_count: Option<u32>,
  pub title: Option<String>,
  /// pdf-inspector's own output, when the PDF is eligible for it.
  pub parsed: Option<Parsed>,
  /// pdf-inspector's markdown for an ineligible PDF, kept for the text fallback.
  markdown: Option<String>,
}

/// OCR mode and forced FirePDF only need the page count and title, so they run detection alone.
#[tracing::instrument(
  name = "parsers::pdf::local_pass",
  skip_all,
  fields(pdf.eligible = Empty, pdf.ineligible_reason = Empty),
  err
)]
pub async fn run_local_pass(
  bytes: &Bytes,
  parser: &PdfOptions,
  force_fire_pdf: bool,
) -> Result<LocalPass, ScrapeURLError> {
  let pass = if parser.mode == PdfMode::Ocr || force_fire_pdf {
    InspectPass::Detect
  } else {
    InspectPass::Extract {
      max_pages: parser.max_pages,
    }
  };
  let mut local = LocalPass {
    pass,
    effective_page_count: 0,
    total_page_count: None,
    title: None,
    parsed: None,
    markdown: None,
  };
  // A failure is recorded on inspect_pdf's span; the parse goes on without a page count.
  let Ok(inspected) = inspect_pdf(bytes, pass).await else {
    return Ok(local);
  };
  local.total_page_count = Some(inspected.page_count);
  local.effective_page_count = match parser.max_pages {
    Some(n) if n > 0 => inspected.page_count.min(n),
    _ => inspected.page_count,
  };
  local.title = inspected.title.clone();
  if pass == InspectPass::Detect {
    return Ok(local);
  }

  let eligibility = Eligibility::new(&inspected);
  let span = Span::current();
  span.record("pdf.eligible", eligibility.is_eligible());
  if !eligibility.is_eligible() {
    span.record("pdf.ineligible_reason", eligibility.to_string().as_str());
  }

  // Fast mode fails with a clear error instead of returning empty content.
  if parser.mode == PdfMode::Fast
    && (inspected.pdf_type == PdfType::Scanned || inspected.pdf_type == PdfType::ImageBased)
  {
    return Err(ScrapeURLError::PDFOCRRequiredError(inspected.pdf_type));
  }

  if eligibility.is_eligible()
    && let Some(markdown) = inspected.markdown
  {
    local.parsed = Some(Parsed::from_markdown(markdown).await);
  } else {
    local.markdown = inspected.markdown;
  }
  Ok(local)
}

/// Text-only extraction is the last resort, as main's pdf-parse pass; forced FirePDF has none.
pub async fn text_fallback(
  bytes: &Bytes,
  parser: &PdfOptions,
  local: LocalPass,
  force_fire_pdf: bool,
) -> Parsed {
  let markdown = if force_fire_pdf {
    String::new()
  } else if local.pass == InspectPass::Detect {
    inspect_pdf(
      bytes,
      InspectPass::Extract {
        max_pages: parser.max_pages,
      },
    )
    .await
    .ok()
    .and_then(|x| x.markdown)
    .unwrap_or_default()
  } else {
    local.markdown.unwrap_or_default()
  };
  Parsed::from_markdown(markdown).await
}
