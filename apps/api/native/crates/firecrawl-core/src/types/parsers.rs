//! Open-source raw document and file parser request/result types.

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};
use ts_rs::TS;

use super::kinded::{KindedSet, kinded};

/// Maximum PDF pages accepted by `pdfParserWithOptions.maxPages` in
/// `apps/api/src/controllers/v2/types.ts`.
pub const MAX_PDF_PAGES: u32 = 10_000;

fn deserialize_opt_max_pages<'de, D>(deserializer: D) -> Result<Option<u32>, D::Error>
where
  D: Deserializer<'de>,
{
  let value = Option::<u32>::deserialize(deserializer)?;
  if let Some(pages) = value
    && !(1..=MAX_PDF_PAGES).contains(&pages)
  {
    return Err(D::Error::custom(format!(
      "maxPages must be between 1 and {MAX_PDF_PAGES}, got {pages}"
    )));
  }
  Ok(value)
}

/// Open-source PDF parsing mode matching `pdfModeSchema` in
/// `apps/api/src/controllers/v2/types.ts`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum CorePdfMode {
  Fast,
  #[default]
  Auto,
}

/// Options accepted by the `"pdf"` entry in `parsers`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct CorePdfParserOptions {
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub mode: Option<CorePdfMode>,
  #[serde(
    default,
    skip_serializing_if = "Option::is_none",
    deserialize_with = "deserialize_opt_max_pages"
  )]
  pub max_pages: Option<u32>,
}

/// Open-source file parser entries accepted as bare names or typed option
/// objects. Generates [`CoreParserKind`] (`"pdf" | "document" | "fallback" | "rawBase64"`).
#[kinded(noun = "parser", default = [Pdf], kind = CoreParserKind)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoreParser {
  Pdf(CorePdfParserOptions),
  Document,
  Fallback,
  RawBase64,
}

pub type CoreParsers = KindedSet<CoreParser>;

/// Local PDF content classification from `pdf-inspector`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum CorePdfType {
  TextBased,
  Scanned,
  ImageBased,
  Mixed,
}

/// Local PDF inspection metadata returned alongside extracted PDF output.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CorePdfInspection {
  pub pdf_type: CorePdfType,
  pub page_count: u32,
  pub confidence: f64,
  pub is_complex: bool,
  pub pages_needing_ocr: Vec<u32>,
  pub processing_time_ms: f64,
}

/// Request options for parsing raw fetched document bytes using open-source
/// local parsers (`pdf`, `document`, `fallback`, `rawBase64`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ParseRawDocumentRequest {
  pub url: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub content_type: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub filename: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub extension_hint: Option<String>,
  #[serde(default)]
  #[ts(as = "Option<_>", optional)]
  pub parsers: CoreParsers,
  #[serde(default)]
  #[ts(as = "Option<_>", optional)]
  pub include_raw_base64: bool,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub max_file_size_bytes: Option<u64>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub parser_override: Option<CoreParserKind>,
}

/// Result of parsing raw fetched document bytes through an open-source parser.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ParseRawDocumentResult {
  pub parser: CoreParserKind,
  pub content_type: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub markdown: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub html: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub raw_html: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub raw_base64: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub title: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub num_pages: Option<u32>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub total_pages: Option<u32>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub pdf_inspection: Option<CorePdfInspection>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub warning: Option<String>,
}
