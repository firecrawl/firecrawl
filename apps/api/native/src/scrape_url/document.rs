use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use url::Url;

use crate::scrape_url::engines::EngineScrapeResultActions;

use super::engines::EngineScrapeProxy;
use std::{collections::HashMap, fmt::Display};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DocumentMetadataCacheState {
  Hit,
  Miss,
}

impl Display for DocumentMetadataCacheState {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      Self::Hit => f.write_str("hit"),
      Self::Miss => f.write_str("miss"),
    }
  }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentMetadata {
  pub title: Option<String>,
  pub scrape_id: String,
  pub source_url: String,
  pub url: Url,
  pub status_code: u16,
  pub num_pages: Option<u32>,
  pub total_pages: Option<u32>,
  pub content_type: String,
  pub timezone: Option<String>,
  pub proxy_used: EngineScrapeProxy,
  pub cache_state: DocumentMetadataCacheState,
  pub cached_at: Option<DateTime<Utc>>,
  pub index_id: Option<String>,
  pub credits_used: Option<u64>,
  pub concurrency_limited: bool,
  pub concurrency_queue_duration_ms: Option<u64>,

  pub extra: HashMap<String, Value>,
}

#[derive(Debug, Serialize)]
pub struct DocumentAttribute {
  pub selector: String,
  pub attribute: String,
  pub values: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
  pub markdown: Option<String>,
  pub html: Option<String>,
  pub raw_html: Option<String>,
  pub links: Option<Vec<String>>,
  pub images: Option<Vec<String>>,
  pub screenshot: Option<Url>,
  pub audio: Option<String>,
  pub video: Option<String>,
  // videos:
  // extract:
  // json:
  pub summary: Option<String>,
  pub answer: Option<String>,
  pub highlights: Option<String>,
  // branding:
  // product:
  // menu:
  pub warning: Option<String>,
  pub attributes: Option<Vec<DocumentAttribute>>,
  pub actions: Option<EngineScrapeResultActions>,
  // change_tracking:
  pub metadata: DocumentMetadata,
}

impl Document {
  pub fn append_warning(&mut self, warning: impl AsRef<str>) {
    let inner = self.warning.take();
    if let Some(mut inner) = inner {
      inner += " ";
      inner += warning.as_ref();
      self.warning.replace(inner);
    } else {
      self.warning.replace(warning.as_ref().to_string());
    }
  }
}
