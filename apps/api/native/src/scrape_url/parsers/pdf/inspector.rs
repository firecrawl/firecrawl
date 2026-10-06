//! pdf-inspector, run on the blocking pool behind a concurrency limit.

use std::{
  sync::{Arc, LazyLock},
  time::Instant,
};

use bytes::Bytes;
use pdf_inspector::PdfProcessResult;
use tokio::sync::Semaphore;
use tracing::{Span, field::Empty};

/// Bounds concurrent pdf-inspector runs (`PDF_EXTRACTION_CONCURRENCY`, default 3);
/// each holds a whole document in memory. Waiters are served first come, first served.
static PDF_EXTRACTION_PERMITS: LazyLock<Arc<Semaphore>> = LazyLock::new(|| {
  let permits = std::env::var("PDF_EXTRACTION_CONCURRENCY")
    .ok()
    .and_then(|x| x.trim().parse::<usize>().ok())
    .filter(|x| *x > 0)
    .unwrap_or(3)
    .min(Semaphore::MAX_PERMITS);
  Arc::new(Semaphore::new(permits))
});

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InspectPass {
  /// Page count, type and title only.
  Detect,
  /// Full extraction to markdown, capped to the first `max_pages` pages.
  Extract { max_pages: Option<u32> },
}

impl InspectPass {
  fn as_str(self) -> &'static str {
    match self {
      Self::Detect => "detect",
      Self::Extract { .. } => "extract",
    }
  }
}

fn millis_since(start: Instant) -> u64 {
  u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX)
}

/// Runs pdf-inspector on the blocking pool, holding an extraction permit until it finishes.
#[tracing::instrument(
  name = "parsers::pdf::inspect_pdf",
  skip_all,
  fields(
    pdf.pass = pass.as_str(),
    pdf.permit_wait_ms = Empty,
    pdf.duration_ms = Empty,
    pdf.type = Empty,
    pdf.page_count = Empty,
    pdf.confidence = Empty,
    pdf.is_complex = Empty,
    pdf.markdown_length = Empty,
  ),
  err
)]
pub async fn inspect_pdf(bytes: &Bytes, pass: InspectPass) -> Result<PdfProcessResult, String> {
  let span = Span::current();
  let waiting_since = Instant::now();
  let permit = Arc::clone(&PDF_EXTRACTION_PERMITS)
    .acquire_owned()
    .await
    .map_err(|e| e.to_string())?;
  span.record("pdf.permit_wait_ms", millis_since(waiting_since));

  let running_since = Instant::now();
  let bytes = bytes.clone();
  let inspected = tokio::task::spawn_blocking(move || {
    let _permit = permit;
    let options = match pass {
      InspectPass::Detect => pdf_inspector::PdfOptions::detect_only(),
      InspectPass::Extract { max_pages: Some(n) } if n > 0 => {
        pdf_inspector::PdfOptions::new().pages(1..=n)
      }
      InspectPass::Extract { .. } => pdf_inspector::PdfOptions::new(),
    };
    pdf_inspector::process_pdf_mem_with_options(&bytes, options).map_err(|e| e.to_string())
  })
  .await
  .map_err(|e| e.to_string())??;

  span.record("pdf.duration_ms", millis_since(running_since));
  span.record("pdf.type", format!("{:?}", inspected.pdf_type).as_str());
  span.record("pdf.page_count", inspected.page_count);
  span.record("pdf.confidence", f64::from(inspected.confidence));
  span.record("pdf.is_complex", inspected.layout.is_complex);
  span.record(
    "pdf.markdown_length",
    inspected.markdown.as_ref().map(String::len),
  );
  Ok(inspected)
}
