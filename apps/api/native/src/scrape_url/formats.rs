use serde::{Deserialize, Serialize};

use super::kinded::{KindedSet, kinded};

#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
pub struct JsonOptions;
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
pub struct DeterministicJsonOptions;
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
pub struct ChangeTrackingOptions;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct ScreenshotOptionsViewport {
  pub width: u32,  // 1-7680
  pub height: u32, // 1-4320
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotOptions {
  pub full_page: bool,
  pub quality: Option<u8>, // 1-100
  pub viewport: Option<ScreenshotOptionsViewport>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
pub struct AttributesOptions;
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
pub struct QuestionOptions;
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
pub struct HighlightsOptions;
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
pub struct QueryOptions;

#[kinded(noun = "format", default = [Markdown])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Format {
  Markdown,
  Html,
  RawHtml,
  Links,
  Images,
  Summary,
  Json(JsonOptions),
  DeterministicJson(DeterministicJsonOptions),
  ChangeTracking(ChangeTrackingOptions),
  Screenshot(ScreenshotOptions),
  Attributes(AttributesOptions),
  Branding,
  Product,
  Menu,
  Question(QuestionOptions),
  Highlights(HighlightsOptions),
  Query(QueryOptions),
  Audio,
  Video,
}

pub type Formats = KindedSet<Format>;
