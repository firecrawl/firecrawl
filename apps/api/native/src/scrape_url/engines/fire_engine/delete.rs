use tracing::instrument;

use super::super::super::error::ScrapeURLError;
use super::{FireEngine, client};

impl FireEngine {
  #[instrument(name = "FireEngine::call_delete", skip(self), err)]
  pub(super) async fn call_delete(&self, job_id: &str) -> Result<(), ScrapeURLError> {
    // TODO: timeout
    client()?
      .delete(format!("{}/scrape/{}", self.url, job_id))
      .send()
      .await?;
    Ok(())
  }
}
