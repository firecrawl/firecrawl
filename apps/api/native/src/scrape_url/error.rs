use serde::Serialize;

use super::{options::ProxyMode, transformers::TransformerError};

#[derive(Debug, thiserror::Error)]
pub enum ScrapeURLError {
  #[error("URL blocked by robots.txt: {reason}")]
  CrawlDenialError { reason: String },

  #[error("no cached data available in lockdown mode")]
  LockdownMissError,

  #[error("page is not available in the index")]
  AgentIndexOnlyError,

  #[error("PDF requires OCR, but the requested mode only supports text-based PDFs")]
  PDFOCRRequiredError(pdf_inspector::PdfType),

  #[error("page failed to load in the browser with error code {code}")]
  SiteError { code: String },

  #[error("SSL/TLS certificate error (skip_tls_verification: {skip_tls_verification})")]
  SSLError { skip_tls_verification: bool },

  #[error("DNS resolution failed for hostname {hostname}")]
  DNSResolutionError { hostname: String },

  #[error("unsupported file: {reason}")]
  UnsupportedFileError { reason: String },

  #[error("action(s) failed: {error}")]
  ActionError { error: String },

  #[error("proxy selection failed")]
  ProxySelectionError,

  // TODO: give these real codes on the JS side; they surface as UNKNOWN_ERROR until then
  #[error("reliable retrieval failed with proxy mode {0:?}")]
  ReliableRetrievalError(ProxyMode),

  #[error("refused to connect to a private or otherwise disallowed address")]
  InsecureConnectionError,

  #[error("invalid URL")]
  InvalidURLError,

  #[error("failed to fetch PDF")]
  PDFFetchFailed,

  #[error("page failed to load without timing out")]
  PageLoadFailed,

  #[error("{engine} failed with an unclassified error: {error}")]
  UnclassifiedEngineError { engine: &'static str, error: String },

  #[error("{engine} returned status {status}")]
  EngineUnavailable { engine: &'static str, status: u16 },

  #[error("{0}")]
  Internal(String),

  #[error(transparent)]
  Wreq(wreq::Error),

  #[error(transparent)]
  Reqwest(#[from] reqwest::Error),

  #[error(transparent)]
  Json(#[from] serde_json::Error),

  #[error(transparent)]
  Io(#[from] std::io::Error),

  #[error(transparent)]
  UrlParse(#[from] url::ParseError),

  #[error(transparent)]
  InvalidHeaderName(#[from] wreq::header::InvalidHeaderName),

  #[error(transparent)]
  InvalidHeaderValue(#[from] wreq::header::InvalidHeaderValue),

  #[error(transparent)]
  Base64(#[from] base64::DecodeError),

  #[error(transparent)]
  Redis(#[from] redis::RedisError),

  #[error(transparent)]
  Sqlx(#[from] sqlx::Error),

  #[error(transparent)]
  Gcs(#[from] google_cloud_storage::Error),

  #[error(transparent)]
  Transformer(#[from] TransformerError),
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum GuardError {
  #[error("refused to connect to a private or otherwise disallowed address")]
  PrivateAddress,

  #[error("invalid URL")]
  InvalidUrl,

  #[error("DNS resolution failed for hostname {0}")]
  Dns(String),
}

impl From<GuardError> for ScrapeURLError {
  fn from(e: GuardError) -> Self {
    match e {
      GuardError::PrivateAddress => Self::InsecureConnectionError,
      GuardError::InvalidUrl => Self::InvalidURLError,
      GuardError::Dns(hostname) => Self::DNSResolutionError { hostname },
    }
  }
}

impl From<wreq::Error> for ScrapeURLError {
  fn from(e: wreq::Error) -> Self {
    let mut source = std::error::Error::source(&e);
    let recovered = loop {
      let Some(s) = source else { break None };
      if let Some(x) = s.downcast_ref::<GuardError>() {
        break Some(x.clone().into());
      }
      source = s.source();
    };

    recovered.unwrap_or(Self::Wreq(e))
  }
}

impl ScrapeURLError {
  pub fn code(&self) -> &'static str {
    match self {
      Self::CrawlDenialError { .. } => "CRAWL_DENIAL",
      Self::LockdownMissError => "SCRAPE_LOCKDOWN_CACHE_MISS",
      Self::AgentIndexOnlyError => "AGENT_INDEX_ONLY",
      Self::PDFOCRRequiredError(_) => "SCRAPE_PDF_OCR_REQUIRED",
      Self::SiteError { .. } => "SCRAPE_SITE_ERROR",
      Self::SSLError { .. } => "SCRAPE_SSL_ERROR",
      Self::DNSResolutionError { .. } => "SCRAPE_DNS_RESOLUTION_ERROR",
      Self::UnsupportedFileError { .. } => "SCRAPE_UNSUPPORTED_FILE_ERROR",
      Self::ActionError { .. } => "SCRAPE_ACTION_ERROR",
      Self::ProxySelectionError => "SCRAPE_PROXY_SELECTION_ERROR",
      Self::ReliableRetrievalError(_)
      | Self::InsecureConnectionError
      | Self::InvalidURLError
      | Self::PDFFetchFailed
      | Self::PageLoadFailed
      | Self::UnclassifiedEngineError { .. }
      | Self::EngineUnavailable { .. }
      | Self::Internal(_)
      | Self::Wreq(_)
      | Self::Reqwest(_)
      | Self::Json(_)
      | Self::Io(_)
      | Self::UrlParse(_)
      | Self::InvalidHeaderName(_)
      | Self::InvalidHeaderValue(_)
      | Self::Base64(_)
      | Self::Redis(_)
      | Self::Sqlx(_)
      | Self::Gcs(_)
      | Self::Transformer(_) => "UNKNOWN_ERROR",
    }
  }

  pub fn to_transport_string(&self) -> String {
    let payload = serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string());
    format!("{}|{}", self.code(), payload)
  }
}

impl Serialize for ScrapeURLError {
  fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
  where
    S: serde::Serializer,
  {
    use serde::ser::SerializeMap;

    let mut map = serializer.serialize_map(None)?;
    match self {
      Self::CrawlDenialError { reason } => {
        map.serialize_entry("reason", reason)?;
      }
      Self::SSLError {
        skip_tls_verification,
      } => {
        map.serialize_entry("skipTlsVerification", skip_tls_verification)?;
      }
      Self::SiteError { code } => {
        map.serialize_entry("errorCode", code)?;
      }
      Self::DNSResolutionError { hostname } => {
        map.serialize_entry("hostname", hostname)?;
      }
      Self::UnsupportedFileError { reason } => {
        map.serialize_entry("reason", reason)?;
      }
      Self::ActionError { error } => {
        map.serialize_entry("errorCode", error)?;
      }
      Self::PDFOCRRequiredError(pdf_type) => {
        map.serialize_entry("pdfType", pdf_type_name(pdf_type))?;
      }
      Self::LockdownMissError | Self::AgentIndexOnlyError | Self::ProxySelectionError => {}
      e => {
        map.serialize_entry("message", &unknown_error_message(&e.to_string()))?;
      }
    }
    map.end()
  }
}

fn pdf_type_name(pdf_type: &pdf_inspector::PdfType) -> &'static str {
  match pdf_type {
    pdf_inspector::PdfType::TextBased => "TextBased",
    pdf_inspector::PdfType::Scanned => "Scanned",
    pdf_inspector::PdfType::ImageBased => "ImageBased",
    pdf_inspector::PdfType::Mixed => "Mixed",
  }
}

fn unknown_error_message(inner: &str) -> String {
  format!(
    "An unexpected internal error occurred while processing your request. Error details: \"{inner}\". This is typically a temporary issue. Please try your request again. If the problem persists, contact support with your request ID and this error message for investigation."
  )
}
