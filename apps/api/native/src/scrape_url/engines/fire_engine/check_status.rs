use reqwest::Client;
use serde::Deserialize;

use super::{
  FireEngine,
  scrape::{FireEngineScrapeCompleted, FireEngineScrapeFailed, FireEngineScrapeProcessing},
};

#[derive(Deserialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum FireEngineScrapeStatus {
  Completed(FireEngineScrapeCompleted),

  #[serde(rename = "delayed")]
  #[serde(alias = "active")]
  #[serde(alias = "waiting")]
  #[serde(alias = "waiting-children")]
  #[serde(alias = "unknown")]
  #[serde(alias = "prioritized")]
  #[serde(alias = "pending")]
  #[allow(dead_code)] // while never read it's still required for parsing properly
  Processing(FireEngineScrapeProcessing),

  Failed(FireEngineScrapeFailed),
}

impl FireEngine {
  pub(super) async fn call_check_status(&self, job_id: &str) -> FireEngineScrapeStatus {
    let client = Client::new(); // TODO: should we cache this
    // TODO: retries may be good here
    let res = client
      .get(format!("{}/scrape/{}", self.url, job_id))
      .send()
      .await
      .unwrap(); // TODO: error handling

    // NOTE: Explicitly do not check status code here.
    // Fire-engine can send 500 for things that we want to parse.

    res.json::<FireEngineScrapeStatus>().await.unwrap() // TODO: error handling
  }
}
