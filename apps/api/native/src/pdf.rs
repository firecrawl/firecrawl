use napi::bindgen_prelude::*;
use napi_derive::napi;
use pdf_inspector::{process_pdf_with_options as rust_process_pdf, PdfOptions, PdfType};

use crate::logging::{embed_logs_in_error, with_native_tracing, NativeContext, NativeLogEntry};

#[napi(object)]
pub struct PdfProcessResult {
  pub pdf_type: String,
  pub markdown: Option<String>,
  pub page_count: i32,
  pub processing_time_ms: f64,
  pub pages_needing_ocr: Vec<i32>,
  pub title: Option<String>,
  pub confidence: f64,
  pub is_complex: bool,
  pub logs: Vec<NativeLogEntry>,
}

fn pdf_type_str(t: PdfType) -> &'static str {
  match t {
    PdfType::TextBased => "TextBased",
    PdfType::Scanned => "Scanned",
    PdfType::ImageBased => "ImageBased",
    PdfType::Mixed => "Mixed",
  }
}

fn to_napi_result(result: pdf_inspector::PdfProcessResult) -> PdfProcessResult {
  PdfProcessResult {
    pdf_type: pdf_type_str(result.pdf_type).to_string(),
    markdown: result.markdown,
    page_count: result.page_count as i32,
    processing_time_ms: result.processing_time_ms as f64,
    pages_needing_ocr: result.pages_needing_ocr.iter().map(|&p| p as i32).collect(),
    title: result.title,
    confidence: result.confidence as f64,
    is_complex: result.layout.is_complex,
    logs: Vec::new(),
  }
}

/// Process a PDF file: detect type, extract text + markdown if text-based.
/// When `max_pages` is provided, only the first N pages are extracted.
/// Pass `ctx` (NativeContext) for structured tracing with scrape_id/url.
#[napi]
pub fn process_pdf(
  path: String,
  max_pages: Option<u32>,
  ctx: Option<NativeContext>,
) -> Result<PdfProcessResult> {
  let traced = with_native_tracing(ctx.as_ref(), "pdf", || {
    tracing::info!(max_pages = ?max_pages, "starting PDF processing");

    let opts = match max_pages {
      Some(n) if n > 0 => PdfOptions::new().pages(1..=n),
      _ => PdfOptions::new(),
    };

    let result = rust_process_pdf(&path, opts).map_err(|e| {
      tracing::error!(error = %e, "PDF processing failed");
      Error::new(
        Status::GenericFailure,
        format!("Failed to process PDF: {e}"),
      )
    })?;

    tracing::info!(
      pdf_type = pdf_type_str(result.pdf_type),
      page_count = result.page_count,
      confidence = %result.confidence,
      is_complex = result.layout.is_complex,
      "PDF processing complete"
    );

    Ok(to_napi_result(result))
  });

  match traced.value {
    Ok(mut result) => {
      result.logs = traced.logs;
      Ok(result)
    }
    Err(err) => Err(embed_logs_in_error(err, &traced.logs)),
  }
}

/// Fast metadata-only detection: page count, title, type, confidence.
/// Skips text extraction, markdown generation, and layout analysis.
/// Pass `ctx` (NativeContext) for structured tracing with scrape_id/url.
#[napi]
pub fn detect_pdf(path: String, ctx: Option<NativeContext>) -> Result<PdfProcessResult> {
  let traced = with_native_tracing(ctx.as_ref(), "pdf", || {
    tracing::info!("starting PDF detection");

    let result = rust_process_pdf(&path, PdfOptions::detect_only()).map_err(|e| {
      tracing::error!(error = %e, "PDF detection failed");
      Error::new(Status::GenericFailure, format!("Failed to detect PDF: {e}"))
    })?;

    tracing::info!(
      pdf_type = pdf_type_str(result.pdf_type),
      page_count = result.page_count,
      confidence = %result.confidence,
      "PDF detection complete"
    );

    Ok(to_napi_result(result))
  });

  match traced.value {
    Ok(mut result) => {
      result.logs = traced.logs;
      Ok(result)
    }
    Err(err) => Err(embed_logs_in_error(err, &traced.logs)),
  }
}
