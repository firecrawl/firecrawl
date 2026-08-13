use reqwest::Client;
use tracing::instrument;

use super::FireEngine;

impl FireEngine {
  #[instrument(name = "FireEngine::call_delete")]
  pub(super) async fn call_delete(&self, job_id: &str) {
    let client = Client::new(); // TODO: cache and reuse
    // TODO: timeout
    client
      .delete(format!("{}/scrape/{}", self.url, job_id))
      .send()
      .await
      .unwrap(); // TODO: error handling
  }
}
