use pdf_inspector::{PdfOptions, PdfType, process_pdf_with_options as rust_process_pdf};

#[derive(Debug, Clone)]
pub struct PdfProcessOutput {
  pub pdf_type: String,
  pub markdown: Option<String>,
  pub page_count: i32,
  pub processing_time_ms: f64,
  pub pages_needing_ocr: Vec<i32>,
  pub title: Option<String>,
  pub confidence: f64,
  pub is_complex: bool,
}

fn pdf_type_str(t: PdfType) -> &'static str {
  match t {
    PdfType::TextBased => "TextBased",
    PdfType::Scanned => "Scanned",
    PdfType::ImageBased => "ImageBased",
    PdfType::Mixed => "Mixed",
  }
}

fn to_output(result: pdf_inspector::PdfProcessResult) -> PdfProcessOutput {
  PdfProcessOutput {
    pdf_type: pdf_type_str(result.pdf_type).to_string(),
    markdown: result.markdown,
    page_count: result.page_count as i32,
    processing_time_ms: result.processing_time_ms as f64,
    pages_needing_ocr: result.pages_needing_ocr.iter().map(|&p| p as i32).collect(),
    title: result.title,
    confidence: result.confidence as f64,
    is_complex: result.layout.is_complex,
  }
}

pub fn process_pdf_file(path: &str, max_pages: Option<u32>) -> Result<PdfProcessOutput, String> {
  tracing::info!(max_pages = ?max_pages, "starting PDF processing");

  let opts = match max_pages {
    Some(n) if n > 0 => PdfOptions::new().pages(1..=n),
    _ => PdfOptions::new(),
  };

  let result = rust_process_pdf(path, opts).map_err(|e| {
    tracing::error!(error = %e, "PDF processing failed");
    format!("Failed to process PDF: {e}")
  })?;

  tracing::info!(
    pdf_type = pdf_type_str(result.pdf_type),
    page_count = result.page_count,
    confidence = %result.confidence,
    is_complex = result.layout.is_complex,
    "PDF processing complete"
  );

  Ok(to_output(result))
}

pub fn detect_pdf_file(path: &str) -> Result<PdfProcessOutput, String> {
  tracing::info!("starting PDF detection");

  let result = rust_process_pdf(path, PdfOptions::detect_only()).map_err(|e| {
    tracing::error!(error = %e, "PDF detection failed");
    format!("Failed to detect PDF: {e}")
  })?;

  tracing::info!(
    pdf_type = pdf_type_str(result.pdf_type),
    page_count = result.page_count,
    confidence = %result.confidence,
    "PDF detection complete"
  );

  Ok(to_output(result))
}
