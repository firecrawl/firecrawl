use std::{error::Error, fmt::Display};

use super::options::ProxyMode;

#[derive(Debug, Clone)]
pub enum ScrapeURLError {
  CrawlDenialError,
  LockdownMissError,
  AgentIndexOnlyError,
  ReliableRetrievalError(ProxyMode),
  InsecureConnectionError,
  InvalidURLError,
  PDFFetchFailed,
  PDFOCRRequiredError(pdf_inspector::PdfType),
  SiteError { code: String },
  SSLError { skip_tls_verification: bool },
  DNSResolutionError { hostname: String },
  UnsupportedFileError { reason: String },
  PageLoadFailed,
  ActionError { error: String },
  ProxySelectionError,
}

impl Display for ScrapeURLError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      Self::CrawlDenialError => f.write_str("CRAWL_DENIAL_ERROR"),
      Self::LockdownMissError => f.write_str("LOCKDOWN_MISS_ERROR"),
      Self::AgentIndexOnlyError => f.write_str("AGENT_INDEX_ONLY_ERROR"),
      Self::ReliableRetrievalError(_) => f.write_str("RELIABLE_RETRIEVAL_ERROR"),
      Self::InsecureConnectionError => f.write_str("INSECURE_CONNECTION_ERROR"),
      Self::InvalidURLError => f.write_str("INVALID_URL_ERROR"),
      Self::PDFFetchFailed => f.write_str("PDF_FETCH_FAILED"),
      Self::PDFOCRRequiredError(_) => f.write_str("PDF_OCR_REQUIRED_ERROR"),
      _ => unimplemented!(), // TODO
    }
  }
}
impl Error for ScrapeURLError {}
