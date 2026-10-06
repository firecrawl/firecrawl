//! Where the PDF bytes come from: the engine, fire-engine's GCS handoff, or the index.

use base64::Engine;
use bytes::Bytes;

use super::{
  super::super::{
    error::ScrapeURLError, index::IndexPDFMetadata, meta::Meta, raw_page::RawPageContent,
  },
  detect::pdf_base64_match,
  firepdf::{FirePdfConfig, Handoff, download_handoff},
  limits::{PDF_DOWNLOAD_MAX_FILE_SIZE, handoff_max_size},
};

pub enum PdfSource {
  Bytes {
    bytes: Bytes,
    /// Set when fire-engine handed the file off by GCS reference.
    handoff: Option<Handoff>,
  },
  /// The index already holds this PDF's converted output.
  Indexed {
    html: String,
    pdf_metadata: Option<IndexPDFMetadata>,
  },
}

pub async fn load_pdf(
  config: &FirePdfConfig,
  meta: &Meta,
  content: RawPageContent,
) -> Result<PdfSource, ScrapeURLError> {
  match content {
    RawPageContent::Bytes(bytes) => Ok(PdfSource::Bytes {
      bytes,
      handoff: None,
    }),
    RawPageContent::BytesOffloaded(offloaded) => {
      let max_bytes = handoff_max_size(config, meta).unwrap_or(PDF_DOWNLOAD_MAX_FILE_SIZE);
      let (bytes, handoff) = download_handoff(config, &offloaded, max_bytes).await?;
      Ok(PdfSource::Bytes {
        bytes,
        handoff: Some(handoff),
      })
    }
    // An undecoded PDF got dumped into the index. Simply run it through our pipeline.
    RawPageContent::IndexFakeHTML(html, None) if pdf_base64_match(&html) => Ok(PdfSource::Bytes {
      bytes: base64::engine::general_purpose::STANDARD
        .decode(&html)?
        .into(),
      handoff: None,
    }),
    RawPageContent::IndexFakeHTML(html, pdf_metadata) => {
      Ok(PdfSource::Indexed { html, pdf_metadata })
    }
    RawPageContent::ChromeRenderedDOM(_) | RawPageContent::GeneratedMarkdown(_) => {
      Err(ScrapeURLError::PDFFetchFailed)
    }
  }
}
