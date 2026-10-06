//! Size caps, time budgets and the local-extraction eligibility rule.

use std::fmt::Display;

use pdf_inspector::{PdfProcessResult, PdfType};

use super::{
  super::super::{error::ScrapeURLError, meta::Meta},
  firepdf::{FirePdfConfig, by_reference_reachable},
  types::PdfMode,
};

/// Above this, FirePDF submits go by GCS reference instead of inline base64.
pub const FIRE_PDF_MAX_FILE_SIZE: usize = 30 * 1024 * 1024;
/// fire-pdf's 100MB body limit over base64 inflation, with margin for the envelope.
pub const FIRE_PDF_INLINE_HARD_MAX_FILE_SIZE: usize = 70 * 1024 * 1024;
/// Unparsed PDFs come back base64'd inline, so they keep a tighter cap.
pub const PDF_DOWNLOAD_MAX_FILE_SIZE: usize = 50 * 1024 * 1024;
/// OCR time budget per page.
const MILLISECONDS_PER_PAGE: u64 = 150;

/// Whether pdf-inspector's own markdown is good enough to serve.
pub enum Eligibility {
  Eligible,
  IneligibleType(PdfType),
  IneligibleConfidence(f32),
  IneligibleComplexity,
  IneligibleEmptyMarkdown,
}

impl Eligibility {
  pub fn new(res: &PdfProcessResult) -> Self {
    if res.pdf_type != PdfType::TextBased {
      Self::IneligibleType(res.pdf_type)
    } else if res.confidence < 0.95 {
      Self::IneligibleConfidence(res.confidence)
    } else if res.layout.is_complex {
      Self::IneligibleComplexity
    } else if let Some(markdown) = res.markdown.as_ref() {
      if markdown.is_empty() {
        Self::IneligibleEmptyMarkdown
      } else {
        Self::Eligible
      }
    } else {
      Self::IneligibleEmptyMarkdown
    }
  }

  pub fn is_eligible(&self) -> bool {
    matches!(self, Eligibility::Eligible)
  }
}

impl Display for Eligibility {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      Eligibility::Eligible => f.write_str("<eligible>"),
      Eligibility::IneligibleType(typ) => write!(f, "pdfType={typ:?}"),
      Eligibility::IneligibleConfidence(conf) => write!(f, "confidence={conf}"),
      Eligibility::IneligibleComplexity => f.write_str("complex layout (tables/columns)"),
      Eligibility::IneligibleEmptyMarkdown => {
        f.write_str("empty markdown (unexpected for TextBased)")
      }
    }
  }
}

/// The size fire-engine may hand a PDF off by GCS reference up to (`pdfMaxSize`),
/// granted only when the by-reference route can take it.
pub fn fire_engine_pdf_max_size(meta: &Meta) -> Option<usize> {
  handoff_max_size(FirePdfConfig::get(), meta)
}

pub fn handoff_max_size(config: &FirePdfConfig, meta: &Meta) -> Option<usize> {
  config.fire_engine_pdf_gcs_bucket.as_ref()?;
  let parser = meta.options.parsers.pdf();
  let force_requested = meta.options.__force_fire_pdf || parser.is_some_and(|x| x.page_aware());
  by_reference_reachable(
    config,
    parser.is_some_and(|x| x.mode == PdfMode::Fast),
    force_requested,
    meta.internal_options.zero_data_retention,
  )
  .then(|| meta.file_size_limit())
}

/// OCR is held to a per-page time budget; local extraction is fast enough to be exempt.
pub fn ensure_ocr_time(
  page_count: u32,
  deadline_ms: Option<i64>,
  now_ms: i64,
) -> Result<(), ScrapeURLError> {
  let Some(deadline_ms) = deadline_ms.filter(|_| page_count > 0) else {
    return Ok(());
  };
  let needed = u64::from(page_count) * MILLISECONDS_PER_PAGE;
  if i64::try_from(needed).unwrap_or(i64::MAX) > deadline_ms.saturating_sub(now_ms) {
    return Err(ScrapeURLError::PDFInsufficientTimeError {
      page_count,
      min_timeout: needed + 5000,
    });
  }
  Ok(())
}
