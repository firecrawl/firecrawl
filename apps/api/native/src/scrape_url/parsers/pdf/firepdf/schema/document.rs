//! The OCR document fire-pdf returns from `/ocr` and `/jobs/:id/result`.

use serde::{Deserialize, Deserializer};
use serde_json::Value;

/// One physical page of markdown, 1-based.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct WirePage {
  pub page: u32,
  pub markdown: String,
}

/// Typed layout blocks of one page (fire-pdf docs/blocks-schema.md). Nullable
/// fields must still be present, as in main's wire schema.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct WirePageBlocks {
  pub page: u32,
  #[serde(deserialize_with = "Option::deserialize")]
  pub width: Option<f64>,
  #[serde(deserialize_with = "Option::deserialize")]
  pub height: Option<f64>,
  /// Documented values are ok | partial | failed; kept open.
  pub status: String,
  pub items: Vec<WireBlockItem>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct WireBlockItem {
  pub id: String,
  pub r#type: String,
  #[serde(deserialize_with = "Option::deserialize")]
  pub label: Option<String>,
  #[serde(deserialize_with = "Option::deserialize")]
  pub bbox: Option<[f64; 4]>,
  pub content: String,
  #[serde(deserialize_with = "Option::deserialize")]
  pub markdown_span: Option<[f64; 2]>,
  pub reading_order: f64,
  #[serde(deserialize_with = "Option::deserialize")]
  pub source: Option<String>,
  pub confidence: WireBlockConfidence,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct WireBlockConfidence {
  #[serde(deserialize_with = "Option::deserialize")]
  pub layout: Option<f64>,
  #[serde(deserialize_with = "Option::deserialize")]
  pub ocr: Option<f64>,
}

fn is_page_number(value: Option<&Value>) -> bool {
  value.and_then(Value::as_u64).is_some_and(|n| n > 0)
}

fn is_nullable_number(value: Option<&Value>) -> bool {
  matches!(value, Some(Value::Null | Value::Number(_)))
}

/// `pages` as page markdown. When blocks are requested without page markdown,
/// fire-pdf sends a legacy block-alias shape here instead, which reads as absent;
/// anything that is neither fails the response.
pub(super) fn deserialize_pages<'de, D: Deserializer<'de>>(
  deserializer: D,
) -> Result<Option<Vec<WirePage>>, D::Error> {
  let Some(value) = Option::<Value>::deserialize(deserializer)? else {
    return Ok(None);
  };
  let Value::Array(items) = &value else {
    return Err(serde::de::Error::custom("pages must be an array"));
  };
  let is_legacy_alias = !items.is_empty()
    && items.iter().all(|item| {
      is_page_number(item.get("page"))
        && is_nullable_number(item.get("width"))
        && is_nullable_number(item.get("height"))
        && item.get("status").is_some_and(Value::is_string)
        && item.get("blocks").is_some_and(Value::is_array)
        && item.get("markdown").is_none()
    });
  if is_legacy_alias {
    return Ok(None);
  }
  serde_json::from_value::<Vec<WirePage>>(value)
    .map(Some)
    .map_err(serde::de::Error::custom)
}

/// A present field, null included; a missing one stays `None`.
fn deserialize_present<'de, D: Deserializer<'de>>(
  deserializer: D,
) -> Result<Option<Value>, D::Error> {
  Value::deserialize(deserializer).map(Some)
}

/// Any JSON number as a page count.
pub(super) fn deserialize_count<'de, D: Deserializer<'de>>(
  deserializer: D,
) -> Result<Option<u32>, D::Error> {
  Ok(Option::<f64>::deserialize(deserializer)?.map(|n| n as u32))
}

/// Any JSON number as milliseconds.
pub(super) fn deserialize_ms<'de, D: Deserializer<'de>>(
  deserializer: D,
) -> Result<Option<i64>, D::Error> {
  Ok(Option::<f64>::deserialize(deserializer)?.map(|n| n as i64))
}

/// Shared by the sync `/ocr` response and the async `/jobs/:id/result` response.
#[derive(Debug, Deserialize)]
pub struct OcrDocument {
  pub markdown: String,
  #[serde(default, deserialize_with = "deserialize_pages")]
  pub pages: Option<Vec<WirePage>>,
  #[serde(default)]
  pub blocks: Option<Vec<WirePageBlocks>>,
  #[serde(default, deserialize_with = "deserialize_count")]
  pub pages_processed: Option<u32>,
  #[serde(default)]
  pub failed_pages: Option<Vec<f64>>,
  #[serde(default)]
  pub partial_pages: Option<Vec<f64>>,
  /// Echo of an honored page-marker request; the only proof the build understood it.
  #[serde(default)]
  pub page_markers: Option<bool>,
  /// Parsed apart from the document, so a stamp this build cannot read never fails the scrape.
  #[serde(default, deserialize_with = "deserialize_present")]
  pub provenance: Option<Value>,
}

/// `GET /jobs/:id/result`.
#[derive(Debug, Deserialize)]
pub struct ResultResponse {
  #[serde(default)]
  pub schema_version: Option<u8>,
  #[serde(flatten)]
  pub document: OcrDocument,
}

impl ResultResponse {
  pub fn parse(body: &[u8]) -> Result<Self, String> {
    let parsed: Self = serde_json::from_slice(body).map_err(|e| e.to_string())?;
    match parsed.schema_version {
      None | Some(1..=3) => Ok(parsed),
      Some(other) => Err(format!("unsupported schema_version {other}")),
    }
  }
}
