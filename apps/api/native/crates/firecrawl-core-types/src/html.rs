//! Open-source HTML transformation and extraction request/result types.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

/// CSS selector and attribute name pair to extract from cleaned HTML.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AttributeRequest {
  pub selector: String,
  pub attribute: String,
}

/// Extracted attribute values matching an [`AttributeRequest`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedAttribute {
  pub selector: String,
  pub attribute: String,
  pub values: Vec<String>,
}

/// Request options for single-pass core HTML cleaning and extraction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct DeriveCoreHtmlRequest {
  pub url: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub content_type: Option<String>,
  pub only_main_content: bool,
  #[serde(default)]
  pub include_tags: Vec<String>,
  #[serde(default)]
  pub exclude_tags: Vec<String>,
  /// Optional node signatures to drop during HTML cleaning.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub drop_signatures: Option<Vec<String>>,
  pub need_metadata: bool,
  pub need_links: bool,
  pub need_images: bool,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub attributes: Option<Vec<AttributeRequest>>,
  pub remove_base64_images: bool,
}

/// Result of single-pass core HTML cleaning and extraction.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct DeriveCoreHtmlResult {
  pub html: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub metadata: Option<BTreeMap<String, Value>>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub links: Option<Vec<String>>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub images: Option<Vec<String>>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub attributes: Option<Vec<ExtractedAttribute>>,
}
