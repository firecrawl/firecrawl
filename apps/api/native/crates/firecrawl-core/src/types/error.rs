//! Typed native errors and `CODE|{json}` transport encoding/decoding.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use super::parsers::{CoreParserKind, CorePdfType};

/// Rust-side error enum for open-source native entrypoints.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CoreNativeError {
  #[error("invalid input for `{argument}` at `{path}`: {message}")]
  InvalidInput {
    argument: String,
    path: String,
    message: String,
  },

  #[error("unsupported file: {reason}")]
  UnsupportedFile { reason: String },

  #[error("PDF requires OCR, but the requested mode only supports text-based PDFs")]
  PdfOcrRequired { pdf_type: CorePdfType },

  #[error(
    "The PDF has {page_count} pages, which requires more processing time than your current timeout allows. Increase the timeout parameter to at least {min_timeout}ms ({} seconds), or {} seconds for network variability.",
    .min_timeout.div_ceil(1000),
    .min_timeout.saturating_mul(3).div_ceil(2000)
  )]
  PdfInsufficientTime { page_count: u32, min_timeout: u64 },

  #[error("HTML processing failed: {message}")]
  HtmlProcessing { message: String },

  #[error("{parser} parser failed: {message}")]
  DocumentParse {
    parser: CoreParserKind,
    message: String,
  },

  #[error("native task panicked: {message}")]
  Panic { message: String },

  #[error("native internal error: {message}")]
  Internal { message: String },
}

/// Structured wire payload carried across the NAPI boundary inside
/// `CODE|{json}` error messages, discriminated by `code`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "code")]
pub enum CoreNativeFailure {
  #[serde(rename = "NATIVE_INVALID_INPUT", rename_all = "camelCase")]
  InvalidInput {
    argument: String,
    path: String,
    message: String,
  },

  #[serde(rename = "SCRAPE_UNSUPPORTED_FILE_ERROR", rename_all = "camelCase")]
  UnsupportedFile { reason: String },

  #[serde(rename = "SCRAPE_PDF_OCR_REQUIRED", rename_all = "camelCase")]
  PdfOcrRequired { pdf_type: CorePdfType },

  #[serde(
    rename = "SCRAPE_PDF_INSUFFICIENT_TIME_ERROR",
    rename_all = "camelCase"
  )]
  PdfInsufficientTime { page_count: u32, min_timeout: u64 },

  #[serde(rename = "NATIVE_HTML_PROCESSING_ERROR", rename_all = "camelCase")]
  HtmlProcessing { message: String },

  #[serde(rename = "NATIVE_DOCUMENT_PARSE_ERROR", rename_all = "camelCase")]
  DocumentParse {
    parser: CoreParserKind,
    message: String,
  },

  #[serde(rename = "NATIVE_PANIC", rename_all = "camelCase")]
  Panic { message: String },

  #[serde(rename = "NATIVE_INTERNAL_ERROR", rename_all = "camelCase")]
  Internal { message: String },
}

impl CoreNativeError {
  /// Converts this error into its tagged wire payload.
  pub fn to_failure(&self) -> CoreNativeFailure {
    match self {
      Self::InvalidInput {
        argument,
        path,
        message,
      } => CoreNativeFailure::InvalidInput {
        argument: argument.clone(),
        path: path.clone(),
        message: message.clone(),
      },
      Self::UnsupportedFile { reason } => CoreNativeFailure::UnsupportedFile {
        reason: reason.clone(),
      },
      Self::PdfOcrRequired { pdf_type } => CoreNativeFailure::PdfOcrRequired {
        pdf_type: *pdf_type,
      },
      Self::PdfInsufficientTime {
        page_count,
        min_timeout,
      } => CoreNativeFailure::PdfInsufficientTime {
        page_count: *page_count,
        min_timeout: *min_timeout,
      },
      Self::HtmlProcessing { message } => CoreNativeFailure::HtmlProcessing {
        message: message.clone(),
      },
      Self::DocumentParse { parser, message } => CoreNativeFailure::DocumentParse {
        parser: *parser,
        message: message.clone(),
      },
      Self::Panic { message } => CoreNativeFailure::Panic {
        message: message.clone(),
      },
      Self::Internal { message } => CoreNativeFailure::Internal {
        message: message.clone(),
      },
    }
  }

  /// Encodes this error as `CODE|{json}` for NAPI rejection messages.
  pub fn to_transport_string(&self) -> String {
    self.to_failure().to_transport_string()
  }
}

impl From<&CoreNativeError> for CoreNativeFailure {
  fn from(error: &CoreNativeError) -> Self {
    error.to_failure()
  }
}

impl From<CoreNativeFailure> for CoreNativeError {
  fn from(failure: CoreNativeFailure) -> Self {
    match failure {
      CoreNativeFailure::InvalidInput {
        argument,
        path,
        message,
      } => Self::InvalidInput {
        argument,
        path,
        message,
      },
      CoreNativeFailure::UnsupportedFile { reason } => Self::UnsupportedFile { reason },
      CoreNativeFailure::PdfOcrRequired { pdf_type } => Self::PdfOcrRequired { pdf_type },
      CoreNativeFailure::PdfInsufficientTime {
        page_count,
        min_timeout,
      } => Self::PdfInsufficientTime {
        page_count,
        min_timeout,
      },
      CoreNativeFailure::HtmlProcessing { message } => Self::HtmlProcessing { message },
      CoreNativeFailure::DocumentParse { parser, message } => {
        Self::DocumentParse { parser, message }
      }
      CoreNativeFailure::Panic { message } => Self::Panic { message },
      CoreNativeFailure::Internal { message } => Self::Internal { message },
    }
  }
}

impl CoreNativeFailure {
  /// Returns the wire error code prefix for this failure.
  pub fn code(&self) -> &'static str {
    match self {
      Self::InvalidInput { .. } => "NATIVE_INVALID_INPUT",
      Self::UnsupportedFile { .. } => "SCRAPE_UNSUPPORTED_FILE_ERROR",
      Self::PdfOcrRequired { .. } => "SCRAPE_PDF_OCR_REQUIRED",
      Self::PdfInsufficientTime { .. } => "SCRAPE_PDF_INSUFFICIENT_TIME_ERROR",
      Self::HtmlProcessing { .. } => "NATIVE_HTML_PROCESSING_ERROR",
      Self::DocumentParse { .. } => "NATIVE_DOCUMENT_PARSE_ERROR",
      Self::Panic { .. } => "NATIVE_PANIC",
      Self::Internal { .. } => "NATIVE_INTERNAL_ERROR",
    }
  }

  /// Encodes this failure as `CODE|{json}` for NAPI rejection messages.
  pub fn to_transport_string(&self) -> String {
    match serde_json::to_string(self) {
      Ok(payload) => format!("{}|{payload}", self.code()),
      Err(err) => {
        let fallback = serde_json::json!({
          "code": "NATIVE_INTERNAL_ERROR",
          "message": format!("failed to serialize native error: {err}"),
        });
        format!("NATIVE_INTERNAL_ERROR|{fallback}")
      }
    }
  }

  /// Decodes a `CODE|{json}` transport string back into a [`CoreNativeFailure`].
  /// Returns `None` when the prefix is missing, does not match the JSON `code`
  /// field, or the payload cannot be deserialized.
  pub fn from_transport_string(transport: &str) -> Option<Self> {
    let (code, payload) = transport.split_once('|')?;
    let value: Value = serde_json::from_str(payload).ok()?;
    if value.get("code").and_then(Value::as_str) != Some(code) {
      return None;
    }
    serde_json::from_value(value).ok()
  }
}
