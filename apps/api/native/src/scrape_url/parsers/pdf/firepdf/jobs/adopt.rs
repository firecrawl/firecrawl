//! `POST /jobs/lookup`: content-level adoption of a job an earlier attempt started.

use std::time::Duration;

use serde_json::Value;
use tracing::{Span, field::Empty};

use super::super::{FirePdfClient, FirePdfJobOptions, io::Method, schema::AdoptionLookupRequest};

/// The lookup is a pure optimization; this keeps a hung fire-pdf from eating the scrape budget.
const ADOPTION_LOOKUP_TIMEOUT: Duration = Duration::from_secs(10);

impl FirePdfClient<'_> {
  /// A job fire-pdf already has for these exact bytes and options, scoped to this
  /// team. Best-effort: any failure means submitting fresh.
  #[tracing::instrument(
    name = "FirePdfClient::lookup_adoptable",
    skip_all,
    fields(
      http.status = Empty,
      fire_pdf.adoption = Empty,
      fire_pdf.adopted_scrape_id = Empty,
      fire_pdf.adopted_status = Empty,
    )
  )]
  pub async fn lookup_adoptable(
    &self,
    sha256: &str,
    options: &FirePdfJobOptions,
  ) -> Option<String> {
    let span = Span::current();
    let team_id = &self.request.team_id;
    let body = serde_json::to_vec(&AdoptionLookupRequest {
      input_sha256: sha256,
      team_id: (!team_id.is_empty()).then_some(team_id.as_str()),
      options: options.wire(),
    })
    .ok()?;
    let response = match self
      .send(
        Method::Post,
        format!("{}/jobs/lookup", self.base_url),
        Some(body),
        Some(ADOPTION_LOOKUP_TIMEOUT),
      )
      .await
    {
      Ok(response) => response,
      Err(error) => {
        span.record("fire_pdf.adoption", "error");
        tracing::error!(error = %error);
        return None;
      }
    };
    span.record("http.status", response.status);
    if response.status == 404 {
      span.record("fire_pdf.adoption", "miss");
      return None;
    }
    if response.status != 200 {
      span.record("fire_pdf.adoption", "error");
      tracing::error!(http.status = response.status, "unexpected adoption lookup status");
      return None;
    }
    let json = response.json_or_empty();
    let Some(scrape_id) = json
      .get("scrape_id")
      .and_then(Value::as_str)
      .filter(|x| !x.is_empty())
    else {
      span.record("fire_pdf.adoption", "malformed");
      return None;
    };
    span.record("fire_pdf.adoption", "hit");
    span.record("fire_pdf.adopted_scrape_id", scrape_id);
    span.record(
      "fire_pdf.adopted_status",
      json.get("status").and_then(Value::as_str),
    );
    Some(scrape_id.to_string())
  }
}
