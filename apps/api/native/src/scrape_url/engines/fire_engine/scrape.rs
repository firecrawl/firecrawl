use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tracing::instrument;
use url::Url;

use super::super::super::{
  actions::InternalAction,
  engines::fire_engine::actions::FireEngineActionResult,
  error::ScrapeURLError,
  options::ScrapeOptionsLocation,
  raw_page::ScrapeActionContent,
};

use super::{CLIENT, FireEngine, file::FireEngineScrapeFile};

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
  pub auto_proxy: bool,

  pub timeout: u32,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub max_age: Option<i32>, // TODO: why the fuck is this in here?

  /// Ceiling for fire-engine's large-PDF GCS handoff. If absent, does not trigger the large-PDF GCS handoff logic.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub pdf_max_size: Option<usize>,

  pub save_scrape_result_to_gcs: bool,
  pub zero_data_retention: bool,
  pub disable_smart_wait_cache: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub persistent_storage: Option<FireEnginePersistentStorage>,
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum FireEngineCompletedState {
  Completed,
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum FireEngineProcessingState {
  Delayed,
  Active,
  Waiting,
  WaitingChildren,
  Unknown,
  Prioritized,
  Pending,
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum FireEngineFailedState {
  Failed,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FireEngineScrapeCompleted {
  #[allow(dead_code)] // only read to pick the variant
  state: Option<FireEngineCompletedState>,

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
  #[allow(dead_code)] // only read to pick the variant
  state: Option<FireEngineProcessingState>,

  pub job_id: String,

  // yeah sure we don't read this but we still need it for untagged to work properly
  #[allow(dead_code)]
  pub processing: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FireEngineScrapeFailed {
  #[allow(dead_code)] // only read to pick the variant
  state: Option<FireEngineFailedState>,

  pub error: String,
  #[serde(default)]
  pub retry_with_stealth: bool,
}

/// Response of both `POST /scrape` and `GET /scrape/:id`. Only the poll sends
/// `state`; when present it must belong to the variant being parsed.
#[derive(Deserialize)]
#[serde(untagged)]
pub enum FireEngineScrapeResponse {
  Completed(FireEngineScrapeCompleted),
  Processing(FireEngineScrapeProcessing),
  Failed(FireEngineScrapeFailed),
}

impl FireEngine {
  #[instrument(
    name = "FireEngine::call_scrape",
    skip(self, request),
    fields(
      request = serde_json::to_string(&request).unwrap_or_default(),
      response.status = tracing::field::Empty,
      response.error = tracing::field::Empty,
      response.retry_with_stealth = tracing::field::Empty,
    ),
    err
  )]
  pub(super) async fn call_scrape<'a>(
    &self,
    request: FireEngineScrapeRequest<'a>,
  ) -> Result<FireEngineScrapeResponse, ScrapeURLError> {
    // TODO: retries may be good here
    let res = CLIENT
      .post(format!("{}/scrape", self.url))
      .json(&request)
      .send()
      .await?;

    // NOTE: Explicitly do not check status code here.
    // Fire-engine can send 500 for things that we want to parse.

    let response = res.json::<FireEngineScrapeResponse>().await?;

    // Failures arrive as `Failed` values, not transport errors, so `err` never
    // fires for them -- record the state and mark the span as errored here,
    // matching the status `do_scrape` gets when it maps this into an error.
    let span = tracing::Span::current();
    match &response {
      FireEngineScrapeResponse::Completed(_) => {
        span.record("response.status", "completed");
      }
      FireEngineScrapeResponse::Processing(_) => {
        span.record("response.status", "processing");
      }
      FireEngineScrapeResponse::Failed(e) => {
        span.record("response.status", "failed");
        span.record("response.error", e.error.as_str());
        span.record("response.retry_with_stealth", e.retry_with_stealth);
        span.in_scope(|| tracing::error!(error = %e.error));
      }
    }

    Ok(response)
  }
}

#[cfg(test)]
mod tests {
  use serde_json::json;

  use super::super::{actions::FireEngineActionResultKind, file::FireEngineScrapeFileContent};
  use super::*;

  fn parse(value: serde_json::Value) -> Result<FireEngineScrapeResponse, serde_json::Error> {
    serde_json::from_slice(value.to_string().as_bytes())
  }

  fn completed(value: serde_json::Value) -> FireEngineScrapeCompleted {
    match parse(value) {
      Ok(FireEngineScrapeResponse::Completed(x)) => x,
      Ok(_) => panic!("parsed as a different variant"),
      Err(e) => panic!("failed to parse: {e}"),
    }
  }

  fn processing(value: serde_json::Value) -> FireEngineScrapeProcessing {
    match parse(value) {
      Ok(FireEngineScrapeResponse::Processing(x)) => x,
      Ok(_) => panic!("parsed as a different variant"),
      Err(e) => panic!("failed to parse: {e}"),
    }
  }

  fn failed(value: serde_json::Value) -> FireEngineScrapeFailed {
    match parse(value) {
      Ok(FireEngineScrapeResponse::Failed(x)) => x,
      Ok(_) => panic!("parsed as a different variant"),
      Err(e) => panic!("failed to parse: {e}"),
    }
  }

  fn handoff_completed() -> serde_json::Value {
    json!({
      "timeTaken": 20.5,
      "content": "",
      "url": "https://example.com/report.pdf",
      "pageStatusCode": 200,
      "responseHeaders": {
        "content-type": "application/pdf",
        "content-length": "59163826",
      },
      "screenshots": [],
      "actionContent": [],
      "actionResults": [],
      "file": {
        "name": "report.pdf",
        "gcs_uri": "gs://fire-engine-handoff/pdf-handoff/0f1e2d3c-job.pdf",
        "sha256": "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0",
        "size_bytes": 59163826,
      },
      "usedMobileProxy": true,
      "timezone": "America/New_York",
    })
  }

  fn site_protection_failure() -> serde_json::Value {
    json!({
      "error": "Site protection detected",
      "failureReason": "site_protection",
      "retryWithStealth": true,
    })
  }

  #[test]
  fn scrape_completed_page_with_actions() {
    let x = completed(json!({
      "jobId": "job-id",
      "timeTaken": 1.5,
      "content": "<html><body>hi</body></html>",
      "url": "https://example.com/landed",
      "pageStatusCode": 403,
      "pageError": "Forbidden",
      "responseHeaders": { "Content-Type": "text/html" },
      "meta": { "anything": 1 },
      "screenshots": ["https://storage.example.com/a.png"],
      "actionContent": [{ "url": "https://example.com/", "html": "<p>a</p>" }],
      "actionResults": [
        { "idx": 0, "type": "screenshot", "result": { "path": "https://storage.example.com/a.png" } },
        { "idx": 1, "type": "scrape", "result": { "url": "https://example.com/", "html": "<p>a</p>" } },
        { "idx": 2, "type": "scrape", "result": { "url": "https://example.com/", "accessibility": "tree" } },
        { "idx": 3, "type": "executeJavascript", "result": { "return": "{\"type\":\"number\",\"value\":1}" } },
        { "idx": 4, "type": "pdf", "result": { "link": "https://storage.example.com/a.pdf" } },
        {
          "idx": 5,
          "type": "getCookies",
          "result": { "cookies": [{ "name": "a", "value": "b", "domain": "example.com" }], "extra": true },
        },
      ],
      "docUrl": "https://storage.example.com/doc",
      "usedMobileProxy": false,
      "youtubeTranscriptContent": { "any": "thing" },
      "timezone": "Europe/Budapest",
    }));

    assert_eq!(x.job_id.as_deref(), Some("job-id"));
    assert_eq!(x.page_status_code, 403);
    assert_eq!(x.page_error.as_deref(), Some("Forbidden"));
    assert_eq!(
      x.url.as_ref().map(|u| u.as_str()),
      Some("https://example.com/landed")
    );
    assert_eq!(x.screenshots.len(), 1);
    assert_eq!(x.action_content.len(), 1);
    assert_eq!(x.action_results.len(), 6);
    assert!(matches!(
      x.action_results[5].kind,
      FireEngineActionResultKind::GetCookies { ref cookies } if cookies.len() == 1
    ));
    assert!(x.file.is_none());
    assert!(!x.used_mobile_proxy);
    assert_eq!(x.timezone.as_deref(), Some("Europe/Budapest"));
  }

  #[test]
  fn scrape_completed_minimal() {
    let x = completed(json!({ "content": "<p>hi</p>", "pageStatusCode": 200 }));
    assert!(x.job_id.is_none());
    assert!(x.response_headers.is_empty());
    assert!(x.screenshots.is_empty());
    assert!(x.action_results.is_empty());
  }

  #[test]
  fn scrape_completed_with_gcs_handoff() {
    let x = completed(handoff_completed());
    let file = x.file.expect("file");
    assert_eq!(file.name, "report.pdf");
    assert!(matches!(
      file.content,
      FireEngineScrapeFileContent::Offloaded { ref gcs_uri, size_bytes: 59163826, .. }
        if gcs_uri == "gs://fire-engine-handoff/pdf-handoff/0f1e2d3c-job.pdf"
    ));
    assert!(x.used_mobile_proxy);
  }

  #[test]
  fn scrape_completed_with_inline_file() {
    let mut value = handoff_completed();
    value["file"] = json!({ "name": "report.pdf", "content": "JVBERi0=" });
    let x = completed(value);
    assert!(matches!(
      x.file.map(|f| f.content),
      Some(FireEngineScrapeFileContent::Base64 { ref content }) if content == "JVBERi0="
    ));

    let mut value = handoff_completed();
    value["file"] = serde_json::Value::Null;
    assert!(completed(value).file.is_none());
  }

  #[test]
  fn scrape_processing() {
    let x = processing(json!({ "jobId": "job-id", "processing": true }));
    assert_eq!(x.job_id, "job-id");
  }

  #[test]
  fn scrape_failed() {
    let x = failed(site_protection_failure());
    assert_eq!(x.error, "Site protection detected");
    assert!(x.retry_with_stealth);

    let x = failed(json!({ "error": "Chrome error: net::ERR_CERT_DATE_INVALID" }));
    assert!(!x.retry_with_stealth);
  }

  #[test]
  fn check_status_completed() {
    let x = completed(json!({
      "jobId": "job-id",
      "state": "completed",
      "processing": false,
      "content": "<p>hi</p>",
      "pageStatusCode": 200,
      "responseHeaders": { "content-type": "text/html" },
      "screenshots": [],
      "actionContent": [],
      "actionResults": [],
      "file": null,
      "usedMobileProxy": true,
    }));
    assert_eq!(x.job_id.as_deref(), Some("job-id"));
    assert!(x.used_mobile_proxy);

    let mut value = handoff_completed();
    value["jobId"] = json!("job-id");
    value["state"] = json!("completed");
    value["processing"] = json!(false);
    assert!(completed(value).file.is_some());
  }

  #[test]
  fn check_status_processing_in_every_state() {
    for state in [
      "delayed",
      "active",
      "waiting",
      "waiting-children",
      "unknown",
      "prioritized",
      "pending",
    ] {
      let x = processing(json!({ "jobId": "job-id", "state": state, "processing": true }));
      assert_eq!(x.job_id, "job-id");
    }
  }

  #[test]
  fn check_status_failed() {
    let mut value = site_protection_failure();
    value["jobId"] = json!("job-id");
    value["state"] = json!("failed");
    value["processing"] = json!(false);
    let x = failed(value);
    assert_eq!(x.error, "Site protection detected");
    assert!(x.retry_with_stealth);

    let x = failed(json!({
      "jobId": "job-id",
      "state": "failed",
      "processing": false,
      "error": "Dns resolution error for hostname: nope.invalid",
    }));
    assert!(!x.retry_with_stealth);
  }

  #[test]
  fn state_must_match_the_variant() {
    // Each of these would fit a different variant's fields if `state` were ignored.
    assert!(
      parse(json!({ "jobId": "job-id", "state": "completed", "processing": false })).is_err()
    );
    assert!(parse(json!({ "jobId": "job-id", "state": "failed", "processing": false })).is_err());
    assert!(
      parse(json!({
        "jobId": "job-id",
        "state": "active",
        "processing": true,
        "error": "boom",
      }))
      .is_ok_and(|x| matches!(x, FireEngineScrapeResponse::Processing(_)))
    );
    assert!(parse(json!({ "jobId": "job-id", "state": "bogus", "processing": true })).is_err());
    assert!(
      parse(json!({
        "jobId": "job-id",
        "state": "bogus",
        "content": "<p>hi</p>",
        "pageStatusCode": 200,
      }))
      .is_err()
    );
  }

  #[test]
  fn rejects_unmatched_responses() {
    assert!(parse(json!({})).is_err());
    assert!(parse(json!({ "processing": true })).is_err());

    let mut value = handoff_completed();
    value["file"] = json!({ "name": "report.pdf" });
    assert!(parse(value).is_err());
  }
}
