use std::fmt::Display;

use base64::Engine;
use bytes::Bytes;
use pdf_inspector::{PdfProcessResult, PdfType, process_pdf_mem_with_options};
use serde::Deserialize;
use tracing::warn;

use self::firepdf::FirePDF;
use super::super::{
  document::{Document, DocumentMetadata, DocumentMetadataCacheState},
  engines::{EngineScrapeContent, EngineScrapeResult},
  error::ScrapeURLError,
  meta::Meta,
};

mod firepdf;

#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PdfMode {
  #[default]
  Auto,

  Fast,
  Ocr,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
pub struct PdfOptions {
  pub mode: PdfMode,
  pub max_pages: Option<u32>,

  /// Include physical per-page markdown alongside document markdown.
  pub page_markdown: bool,
}

enum Eligibility {
  Eligible,
  IneligibleType(PdfType),
  IneligibleConfidence(f32),
  IneligibleComplexity,
  IneligibleEmptyMarkdown,
}

impl Eligibility {
  fn new(res: &PdfProcessResult) -> Self {
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

  fn is_eligible(&self) -> bool {
    matches!(self, Eligibility::Eligible)
  }
}

impl Display for Eligibility {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      Eligibility::Eligible => f.write_str("<eligible>"),
      Eligibility::IneligibleType(typ) => write!(f, "pdfType={:?}", typ),
      Eligibility::IneligibleConfidence(conf) => write!(f, "confidence={}", conf),
      Eligibility::IneligibleComplexity => f.write_str("complex layout (tables/columns)"),
      Eligibility::IneligibleEmptyMarkdown => {
        f.write_str("empty markdown (unexpected for TextBased)")
      }
    }
  }
}

fn pdf_content_type_match(content_type: &str) -> bool {
  let normalized = content_type.to_lowercase();

  normalized == "application/pdf" || normalized.starts_with("application/pdf;")
}

fn pdf_binary_match(bytes: &Bytes) -> bool {
  bytes[..usize::min(bytes.len(), 1024)]
    .windows(4)
    .any(|w| w == b"%PDF")
}

fn pdf_file_extension_match(filename: &str) -> bool {
  filename.ends_with(".pdf")
}

pub fn has_pdf_signal(result: &EngineScrapeResult) -> bool {
  let is_pdf_content_type = pdf_content_type_match(&result.content_type);

  let is_pdf_binary = match &result.content {
    EngineScrapeContent::Bytes(bytes) => pdf_binary_match(bytes),
    _ => false,
  };

  let is_pdf_file_extension = result
    .filename
    .as_ref()
    .map(|x| pdf_file_extension_match(x))
    .unwrap_or(false);

  is_pdf_content_type || is_pdf_binary || is_pdf_file_extension
}

struct PdfResult {
  markdown: String,
  html: String,
}

pub async fn parse_pdf(
  meta: &Meta,
  result: EngineScrapeResult,
) -> Result<Document, ScrapeURLError> {
  let bytes = match result.content {
    EngineScrapeContent::Bytes(x) => x,
    _ => unreachable!(),
  };

  if let Some(parser) = meta.options.parsers.pdf() {
    if pdf_binary_match(&bytes) {
      let force_fire_pdf =
        (meta.options.__force_fire_pdf || parser.page_markdown) && FirePDF::get().is_some();

      let (mut res, pdf_result): (Option<PdfResult>, PdfProcessResult) = {
        if force_fire_pdf || parser.mode == PdfMode::Ocr {
          Ok((
            None,
            process_pdf_mem_with_options(&bytes, pdf_inspector::PdfOptions::detect_only()).unwrap(),
          ))
        } else {
          let process = process_pdf_mem_with_options(
            &bytes,
            match parser.max_pages {
              Some(n) if n > 0 => pdf_inspector::PdfOptions::new().pages(1..=n),
              _ => pdf_inspector::PdfOptions::new(),
            },
          )
          .unwrap();

          let elig = Eligibility::new(&process);

          // TODO: SHADOW STUFF
          // let chars_per_page = process.markdown.as_ref().map(|x| x.len()).unwrap_or(0) as f64
          //   / f64::max(process.page_count as f64, 1.);
          // let shadow_eligible = process.markdown.is_some()
          //   // && PDF_SHADOW_COMPARISON_ENABLE.is_some() // TODO:
          //   && (process.pdf_type == PdfType::TextBased
          //     || (process.pdf_type == PdfType::Mixed && chars_per_page >= 200.));

          if parser.mode == PdfMode::Fast
            && (process.pdf_type == PdfType::Scanned || process.pdf_type == PdfType::ImageBased)
          {
            Err(ScrapeURLError::PDFOCRRequiredError(process.pdf_type))
          } else if elig.is_eligible()
            && let Some(markdown) = process.markdown.as_ref()
          {
            Ok((
              Some(PdfResult {
                html: markdown::to_html_with_options(markdown, &markdown::Options::gfm())
                  .expect("this cannot error"),
                markdown: markdown.clone(),
              }),
              process,
            ))
          } else {
            Ok((None, process))
          }
        }
      }?;

      let effective_page_count = if let Some(max_pages) = parser.max_pages {
        pdf_result.page_count.min(max_pages)
      } else {
        pdf_result.page_count
      };

      // if result.is_none() && effective_page_count > 0 && effective_page_count * 150
      // TODO: timeout check

      let skip_ocr = parser.mode == PdfMode::Fast && !force_fire_pdf;
      if res.is_none()
        && !skip_ocr
        && let Some(fire_pdf) = FirePDF::get()
      {
        if bytes.len() >= 30 * 1024 * 1024 {
          warn!(
            file_size_bytes = bytes.len(),
            max_size_bytes = 30 * 1024 * 124,
            "PDF skipped by Fire PDF: exceeds size cap"
          );
        }

        res = Some(fire_pdf.process().await);
      }

      // i hate this - Mogery
      let res = if let Some(res) = res {
        res
      } else {
        PdfResult {
          markdown: "".to_string(),
          html: "".to_string(),
        }
      };

      Ok(Document {
        markdown: Some(res.markdown),
        raw_html: Some(res.html),
        html: None,
        links: None,
        images: None,
        screenshot: None,
        audio: None,
        video: None,
        summary: None,
        answer: None,
        highlights: None,
        attributes: None,
        actions: result.actions,
        warning: None,
        // TODO: pages
        metadata: DocumentMetadata {
          scrape_id: meta.id.clone(),
          source_url: meta.source_url(),
          url: result.url,
          status_code: result.status_code,
          content_type: result.content_type,
          timezone: result.timezone,
          proxy_used: result.proxy_used,
          cache_state: DocumentMetadataCacheState::Miss,
          cached_at: None,
          index_id: None,
          credits_used: None,
          concurrency_limited: false,
          concurrency_queue_duration_ms: None,
          title: pdf_result.title,
          num_pages: Some(effective_page_count),
          extra: Default::default(),
        },
      })
    } else {
      Err(ScrapeURLError::PDFFetchFailed)
    }
  } else {
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(Document {
      markdown: Some(encoded.clone()),
      raw_html: Some(encoded.clone()),
      html: Some(encoded.clone()),
      links: None,
      images: None,
      screenshot: result.screenshot,
      audio: None,
      video: None,
      summary: None,
      answer: None,
      highlights: None,
      attributes: None,
      actions: result.actions,
      warning: None,
      metadata: DocumentMetadata {
        scrape_id: meta.id.clone(),
        source_url: meta.source_url(),
        url: result.url,
        status_code: result.status_code,
        content_type: result.content_type,
        timezone: result.timezone,
        proxy_used: result.proxy_used,
        cache_state: DocumentMetadataCacheState::Miss,
        cached_at: None,
        index_id: None,
        credits_used: None,
        concurrency_limited: false,
        concurrency_queue_duration_ms: None,
        title: None,
        num_pages: None,
        extra: Default::default(),
      },
    })
  }
}
