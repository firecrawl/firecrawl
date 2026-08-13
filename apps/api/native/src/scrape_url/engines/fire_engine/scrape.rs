use std::collections::HashMap;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use tracing::instrument;
use url::Url;

use super::super::super::{
  actions::InternalAction,
  engines::{ScrapeActionContent, fire_engine::actions::FireEngineActionResult},
  options::ScrapeOptionsLocation,
};

use super::FireEngine;

#[derive(Debug, Serialize)]
pub enum FireEngineScrapeRequestEngine {
  #[serde(rename = "chrome-cdp")]
  ChromeCDP,
  // everything else is deprecated
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FireEnginePersistentStorage {
  pub unique_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FireEngineScrapeRequest<'a> {
  pub engine: FireEngineScrapeRequestEngine,
  pub url: &'a Url,

  #[serde(skip_serializing_if = "HashMap::is_empty")]
  pub headers: &'a HashMap<String, String>,

  pub scrape_id: &'a String,
  pub block_media: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub priority: Option<u32>,
  // pub log_request: bool, // TODO: default: true? unsure what this is - Mogery
  pub instant_return: bool,
  pub geolocation: &'a ScrapeOptionsLocation,
  pub skip_tls_verification: bool,
  #[serde(skip_serializing_if = "Vec::is_empty")]
  pub actions: Vec<InternalAction>,
  pub mobile: bool,

  /// Opt out of render-engine routing (blockMedia: false usually forces it).
  pub force_non_renderer: bool,

  pub mobile_proxy: bool,

  pub timeout: u32,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub max_age: Option<i32>, // TODO: why the fuck is this in here?
  pub save_scrape_result_to_gcs: bool,
  pub zero_data_retention: bool,
  pub disable_smart_wait_cache: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub persistent_storage: Option<FireEnginePersistentStorage>,
}

#[derive(Deserialize)]
pub struct FireEngineScrapeFile {
  pub name: String,
  pub content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FireEngineScrapeCompleted {
  /// Only `Some` if we are deferring deletion.
  pub job_id: Option<String>,

  pub content: String,
  // pub json: Option<serde_json::Value>, // TODO: CFR?
  pub url: Option<Url>,

  pub page_status_code: u16,
  pub page_error: Option<String>,

  // TODO: this needs to be non-optional, might need fixes on f-e side to ensure reliability
  #[serde(default)]
  pub response_headers: HashMap<String, String>,

  #[serde(default)]
  pub screenshots: Vec<Url>,
  #[serde(default)]
  pub action_content: Vec<ScrapeActionContent>,
  #[serde(default)]
  pub action_results: Vec<FireEngineActionResult>,
  pub file: Option<FireEngineScrapeFile>,
  // pub doc_url: Option<String>, // TODO: GCS doc if using saveScrapeResultToGCS, but if this is present than the others aren't. Need to fix type
  #[serde(default)]
  pub used_mobile_proxy: bool,
  pub timezone: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FireEngineScrapeProcessing {
  pub job_id: String,

  // yeah sure we don't read this but we still need it for untagged to work properly
  #[allow(dead_code)]
  pub processing: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FireEngineScrapeFailed {
  pub error: String,
  #[serde(default)]
  pub retry_with_stealth: bool,
}

#[derive(Deserialize)]
#[serde(untagged)]
pub enum FireEngineScrapeResponse {
  Completed(FireEngineScrapeCompleted),
  Processing(FireEngineScrapeProcessing),
  Failed(FireEngineScrapeFailed),
}

impl FireEngine {
  #[instrument(name = "FireEngine::call_scrape")]
  pub(super) async fn call_scrape<'a>(
    &self,
    request: FireEngineScrapeRequest<'a>,
  ) -> FireEngineScrapeResponse {
    let client = Client::new(); // TODO: should we cache this
    // TODO: retries may be good here
    let res = client
      .post(format!("{}/scrape", self.url))
      .json(&request)
      .send()
      .await
      .unwrap(); // TODO: error handling

    // NOTE: Explicitly do not check status code here.
    // Fire-engine can send 500 for things that we want to parse.

    res.json::<FireEngineScrapeResponse>().await.unwrap() // TODO: error handling
  }
}
