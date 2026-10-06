use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use super::{options::ProxyMode, parsers::FirePdfError, transformers::TransformerError};

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

  #[error(
    "The PDF has {page_count} pages, which requires more processing time than your current timeout allows. PDF processing time scales with page count - larger PDFs need longer timeouts. To successfully scrape this PDF, increase the timeout parameter in your scrape request to at least {min_timeout}ms ({} seconds). For very large PDFs, consider using a timeout of {} seconds or more to account for network variability.",
    .min_timeout.div_ceil(1000),
    (.min_timeout * 3).div_ceil(2000)
  )]
  PDFInsufficientTimeError { page_count: u32, min_timeout: u64 },

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

  #[error("all scraping engines failed to retrieve content from this URL")]
  NoEnginesLeftError { fallback_list: Vec<&'static str> },

  #[error("actions are not supported by any available engines")]
  ActionsNotSupportedError,
  #[error("{0} is not supported yet")]
  NotSupported(&'static str),

  #[error("invalid {argument}: {error}")]
  InvalidInput {
    argument: &'static str,
    error: String,
  },

  #[error("scrape panicked: {0}")]
  Panic(String),

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

  #[error(transparent)]
  FirePDF(#[from] FirePdfError),
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
  pub fn payload(&self) -> ScrapeErrorPayload {
    let message = self.to_string();
    match self {
      Self::CrawlDenialError { reason } => ScrapeErrorPayload::CrawlDenial {
        reason: reason.clone(),
      },
      Self::LockdownMissError => ScrapeErrorPayload::LockdownCacheMiss,
      Self::AgentIndexOnlyError => ScrapeErrorPayload::AgentIndexOnly,
      Self::PDFOCRRequiredError(pdf_type) => ScrapeErrorPayload::PdfOcrRequired {
        pdf_type: (*pdf_type).into(),
      },
      Self::PDFInsufficientTimeError {
        page_count,
        min_timeout,
      } => ScrapeErrorPayload::PdfInsufficientTime {
        page_count: *page_count,
        min_timeout: *min_timeout,
      },
      Self::SiteError { code } => ScrapeErrorPayload::SiteError {
        error_code: code.clone(),
      },
      Self::SSLError {
        skip_tls_verification,
      } => ScrapeErrorPayload::SslError {
        skip_tls_verification: *skip_tls_verification,
      },
      Self::DNSResolutionError { hostname } => ScrapeErrorPayload::DnsResolutionError {
        hostname: hostname.clone(),
      },
      Self::UnsupportedFileError { reason } => ScrapeErrorPayload::UnsupportedFileError {
        reason: reason.clone(),
      },
      Self::ActionError { error } => ScrapeErrorPayload::ActionError {
        error_code: error.clone(),
      },
      Self::ProxySelectionError => ScrapeErrorPayload::ProxySelectionError,
      Self::NoEnginesLeftError { fallback_list } => ScrapeErrorPayload::AllEnginesFailed {
        fallback_list: fallback_list.iter().map(|x| x.to_string()).collect(),
        message: no_engines_left_message(fallback_list),
      },
      Self::ActionsNotSupportedError => ScrapeErrorPayload::ActionsNotSupported {
        message: "Actions are not supported by any available engines. Actions require Fire Engine (fire-engine) to be enabled.".to_string(),
      },
      Self::Transformer(TransformerError::JsonContentTooLarge) => {
        ScrapeErrorPayload::JsonContentTooLarge { message }
      }
      Self::ReliableRetrievalError(proxy) => ScrapeErrorPayload::ReliableRetrievalError {
        proxy: *proxy,
        message,
      },
      Self::InsecureConnectionError => ScrapeErrorPayload::InsecureConnectionError { message },
      Self::InvalidURLError => ScrapeErrorPayload::InvalidUrlError { message },
      Self::PDFFetchFailed => ScrapeErrorPayload::PdfFetchFailed { message },
      Self::PageLoadFailed => ScrapeErrorPayload::PageLoadFailed { message },
      Self::UnclassifiedEngineError { engine, error } => {
        ScrapeErrorPayload::UnclassifiedEngineError {
          engine: engine.to_string(),
          error: error.clone(),
          message,
        }
      }
      Self::EngineUnavailable { engine, status } => ScrapeErrorPayload::EngineUnavailable {
        engine: engine.to_string(),
        status: *status,
        message,
      },
      Self::NotSupported(feature) => ScrapeErrorPayload::NotSupported {
        feature: feature.to_string(),
        message,
      },
      Self::InvalidInput { argument, .. } => ScrapeErrorPayload::InvalidInput {
        argument: argument.to_string(),
        message,
      },
      Self::Panic(_) => ScrapeErrorPayload::Panic { message },
      Self::Transformer(TransformerError::Join(e)) if e.is_panic() => {
        ScrapeErrorPayload::Panic { message }
      }
      Self::Internal(_)
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
      | Self::Transformer(_)
      | Self::FirePDF(_) => ScrapeErrorPayload::Unknown {
        message: unknown_error_message(&message),
      },
    }
  }

  /// `CODE|{payload}`, the format TS `deserializeTransportableError` reads.
  pub fn to_transport_string(&self) -> String {
    let payload = serde_json::to_value(self.payload()).unwrap_or_else(|e| {
      serde_json::json!({
        "code": "UNKNOWN_ERROR",
        "message": unknown_error_message(&e.to_string()),
      })
    });
    let code = payload
      .get("code")
      .and_then(Value::as_str)
      .unwrap_or("UNKNOWN_ERROR");
    format!("{code}|{payload}")
  }
}

/// Structured payload of a rejected `scrapeUrl` promise, discriminated by
/// `code`. Codes shared with TS `error.ts` carry the fields its `deserialize`
/// reads; the Rust-specific codes below them also carry a `message`.
#[derive(Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "code")]
#[ts(rename = "ScrapeError")]
pub enum ScrapeErrorPayload {
  #[serde(rename = "CRAWL_DENIAL")]
  CrawlDenial { reason: String },

  #[serde(rename = "SCRAPE_LOCKDOWN_CACHE_MISS")]
  LockdownCacheMiss,

  #[serde(rename = "AGENT_INDEX_ONLY")]
  AgentIndexOnly,

  #[serde(rename = "SCRAPE_PDF_OCR_REQUIRED", rename_all = "camelCase")]
  PdfOcrRequired { pdf_type: PdfType },

  #[serde(rename = "SCRAPE_PDF_INSUFFICIENT_TIME_ERROR", rename_all = "camelCase")]
  PdfInsufficientTime { page_count: u32, min_timeout: u64 },

  #[serde(rename = "SCRAPE_SITE_ERROR", rename_all = "camelCase")]
  SiteError { error_code: String },

  #[serde(rename = "SCRAPE_SSL_ERROR", rename_all = "camelCase")]
  SslError { skip_tls_verification: bool },

  #[serde(rename = "SCRAPE_DNS_RESOLUTION_ERROR")]
  DnsResolutionError { hostname: String },

  #[serde(rename = "SCRAPE_UNSUPPORTED_FILE_ERROR")]
  UnsupportedFileError { reason: String },

  #[serde(rename = "SCRAPE_ACTION_ERROR", rename_all = "camelCase")]
  ActionError { error_code: String },

  #[serde(rename = "SCRAPE_PROXY_SELECTION_ERROR")]
  ProxySelectionError,

  #[serde(rename = "SCRAPE_ALL_ENGINES_FAILED", rename_all = "camelCase")]
  AllEnginesFailed {
    fallback_list: Vec<String>,
    message: String,
  },

  #[serde(rename = "SCRAPE_ACTIONS_NOT_SUPPORTED")]
  ActionsNotSupported { message: String },

  #[serde(rename = "SCRAPE_JSON_CONTENT_TOO_LARGE")]
  JsonContentTooLarge { message: String },

  #[serde(rename = "UNKNOWN_ERROR")]
  Unknown { message: String },

  #[serde(rename = "SCRAPE_RELIABLE_RETRIEVAL_ERROR")]
  ReliableRetrievalError { proxy: ProxyMode, message: String },

  #[serde(rename = "SCRAPE_INSECURE_CONNECTION_ERROR")]
  InsecureConnectionError { message: String },

  #[serde(rename = "SCRAPE_INVALID_URL_ERROR")]
  InvalidUrlError { message: String },

  #[serde(rename = "SCRAPE_PDF_FETCH_FAILED")]
  PdfFetchFailed { message: String },

  #[serde(rename = "SCRAPE_PAGE_LOAD_FAILED")]
  PageLoadFailed { message: String },

  #[serde(rename = "SCRAPE_UNCLASSIFIED_ENGINE_ERROR")]
  UnclassifiedEngineError {
    engine: String,
    error: String,
    message: String,
  },

  #[serde(rename = "SCRAPE_ENGINE_UNAVAILABLE")]
  EngineUnavailable {
    engine: String,
    status: u16,
    message: String,
  },

  #[serde(rename = "SCRAPE_NOT_SUPPORTED")]
  NotSupported { feature: String, message: String },

  #[serde(rename = "SCRAPE_INVALID_INPUT")]
  InvalidInput { argument: String, message: String },

  #[serde(rename = "SCRAPE_PANIC")]
  Panic { message: String },
}

impl ScrapeErrorPayload {
  /// Inverse of [`ScrapeURLError::to_transport_string`]. `None` for anything
  /// that is not a well-formed `scrapeUrl` error.
  pub fn from_transport_string(transport: &str) -> Option<Self> {
    let (code, payload) = transport.split_once('|')?;
    let payload: Value = serde_json::from_str(payload).ok()?;
    if payload.get("code").and_then(Value::as_str) != Some(code) {
      return None;
    }
    serde_json::from_value(payload).ok()
  }
}

/// PDF classification carried by `SCRAPE_PDF_OCR_REQUIRED`.
#[derive(Debug, PartialEq, Serialize, Deserialize, TS)]
pub enum PdfType {
  TextBased,
  Scanned,
  ImageBased,
  Mixed,
}

impl From<pdf_inspector::PdfType> for PdfType {
  fn from(pdf_type: pdf_inspector::PdfType) -> Self {
    match pdf_type {
      pdf_inspector::PdfType::TextBased => Self::TextBased,
      pdf_inspector::PdfType::Scanned => Self::Scanned,
      pdf_inspector::PdfType::ImageBased => Self::ImageBased,
      pdf_inspector::PdfType::Mixed => Self::Mixed,
    }
  }
}

/// Same text as TS `NoEnginesLeftError`, including its self-hosted variant.
fn no_engines_left_message(fallback_list: &[&str]) -> String {
  let contact = if std::env::var("USE_DB_AUTHENTICATION").as_deref() == Ok("true") {
    "If the issue persists, contact us at help@firecrawl.com with your request ID for investigation."
  } else {
    "Check your server logs for more detailed error information from each engine."
  };
  format!(
    "All scraping engines failed to retrieve content from this URL. Engines tried: [{}]. This usually happens when: (1) The URL is invalid or the page doesn't exist (404), (2) The website is blocking automated access, (3) The website is down or unreachable, (4) The page requires authentication. Double check the URL is correct and accessible in a browser. {contact}",
    fallback_list.join(", ")
  )
}

fn unknown_error_message(inner: &str) -> String {
  format!(
    "An unexpected internal error occurred while processing your request. Error details: \"{inner}\". This is typically a temporary issue. Please try your request again. If the problem persists, contact support with your request ID and this error message for investigation."
  )
}
