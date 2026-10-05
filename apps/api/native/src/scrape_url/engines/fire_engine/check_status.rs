use tracing::instrument;

use super::super::super::error::ScrapeURLError;
use super::{CLIENT, FireEngine, scrape::FireEngineScrapeResponse};

impl FireEngine {
  #[instrument(
    name = "FireEngine::call_check_status",
    skip(self),
    fields(response.status = tracing::field::Empty),
    err
  )]
  pub(super) async fn call_check_status(
    &self,
    job_id: &str,
  ) -> Result<FireEngineScrapeResponse, ScrapeURLError> {
    // TODO: retries may be good here
    let res = CLIENT
      .get(format!("{}/scrape/{}", self.url, job_id))
      .send()
      .await?;

    // NOTE: Explicitly do not check status code here.
    // Fire-engine can send 500 for things that we want to parse.

    let status = res.json::<FireEngineScrapeResponse>().await?;

    tracing::Span::current().record(
      "response.status",
      match &status {
        FireEngineScrapeResponse::Completed(_) => "completed",
        FireEngineScrapeResponse::Processing(_) => "processing",
        FireEngineScrapeResponse::Failed(_) => "failed",
      },
    );

    Ok(status)
  }
}
