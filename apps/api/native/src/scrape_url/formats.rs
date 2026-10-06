use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::kinded::{KindedSet, kinded};

#[derive(Debug, Clone, PartialEq, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields = nullable)]
pub struct JsonOptions {
  pub prompt: Option<String>,
  pub schema: Option<serde_json::Value>,
  pub check_prompt_injection: Option<bool>,
}
#[derive(Debug, Clone, PartialEq, Default, Deserialize, TS)]
#[ts(optional_fields = nullable)]
pub struct DeterministicJsonOptions {
  pub prompt: Option<String>,
  pub schema: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
pub enum ChangeTrackingMode {
  #[serde(rename = "json")]
  Json,
  #[serde(rename = "git-diff")]
  GitDiff,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize, TS)]
#[ts(optional_fields = nullable)]
pub struct ChangeTrackingOptions {
  pub prompt: Option<String>,
  pub schema: Option<serde_json::Value>,
  #[serde(default)]
  #[ts(as = "Option<_>", optional)]
  pub modes: Vec<ChangeTrackingMode>,
  #[serde(default)]
  pub tag: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, TS)]
pub struct ScreenshotOptionsViewport {
  pub width: u32,  // 1-7680
  pub height: u32, // 1-4320
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields = nullable)]
pub struct ScreenshotOptions {
  #[serde(default)]
  #[ts(as = "Option<_>", optional)]
  pub full_page: bool,
  pub quality: Option<u8>, // 1-100
  pub viewport: Option<ScreenshotOptionsViewport>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize, TS)]
pub struct AttributesSelector {
  pub selector: String,
  pub attribute: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize, TS)]
pub struct AttributesOptions {
  pub selectors: Vec<AttributesSelector>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum BrandingMode {
  Auto,
  Fast,
  Standard,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize, TS)]
#[ts(optional_fields = nullable)]
pub struct BrandingOptions {
  pub mode: Option<BrandingMode>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize, TS)]
pub struct QuestionOptions {
  pub question: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize, TS)]
pub struct HighlightsOptions {
  pub query: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum QueryMode {
  #[default]
  Freeform,
  DirectQuote,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize, TS)]
pub struct QueryOptions {
  pub prompt: String,
  #[serde(default)]
  #[ts(as = "Option<_>", optional)]
  pub mode: QueryMode,
}

#[kinded(noun = "format", default = [Markdown])]
#[derive(Debug, Clone, PartialEq)]
pub enum Format {
  Markdown,
  Html,
  RawHtml,
  RawBase64,
  Links,
  Images,
  Summary,
  Json(JsonOptions),
  DeterministicJson(DeterministicJsonOptions),
  ChangeTracking(ChangeTrackingOptions),
  Screenshot(ScreenshotOptions),
  Attributes(AttributesOptions),
  Branding(BrandingOptions),
  Product,
  Menu,
  Question(QuestionOptions),
  Highlights(HighlightsOptions),
  Query(QueryOptions),
  Audio,
  Video,
}

pub type Formats = KindedSet<Format>;
