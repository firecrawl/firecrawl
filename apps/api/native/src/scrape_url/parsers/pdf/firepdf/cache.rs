//! Cached FirePDF results, looked up through fire-pdf's cache service. The
//! service applies the read-time rules and the `refresh` budget, and fire-pdf
//! writes the entries itself.

use std::time::Duration;

use tracing::{Instrument, field::Empty};

use super::{
  FirePdfClient, FirePdfJobOptions, FirePdfResult,
  io::{FirePdfIo, Method},
  schema::{CacheLookupOptions, CacheLookupOutcome, CacheLookupRequest},
};

/// The service's own read bound; past it the lookup is a miss and the document is parsed.
const LOOKUP_TIMEOUT_MS: i64 = 5_000;
/// One retry within the same bound covers a connection dropped before it was handled.
const LOOKUP_TRIES: u32 = 2;

impl<I: FirePdfIo> FirePdfClient<'_, I> {
  /// Whether a lookup can happen at all, checked before hashing the payload.
  pub fn cache_applicable(&self, options: &FirePdfJobOptions) -> bool {
    self.config.cache_base_url.is_some() && !self.request.zdr && options.cacheable()
  }

  /// A usable cached result, or `None` (a miss, or a failed lookup). `keys` are
  /// probed in order: the raw bytes' hash, then the historical base64-payload hash.
  pub async fn lookup_cache(
    &self,
    keys: &[String],
    options: &FirePdfJobOptions,
  ) -> Option<FirePdfResult> {
    let base_url = self.config.cache_base_url.as_deref()?;
    if !self.cache_applicable(options) {
      return None;
    }
    let span = tracing::info_span!(
      "fire_pdf::cache_lookup",
      fire_pdf.cache.event = Empty,
      fire_pdf.cache.variant = Empty,
      fire_pdf.cache.key = Empty,
    );
    self
      .lookup_cache_inner(base_url, keys, options, &span)
      .instrument(span.clone())
      .await
  }

  async fn lookup_cache_inner(
    &self,
    base_url: &str,
    keys: &[String],
    options: &FirePdfJobOptions,
    span: &tracing::Span,
  ) -> Option<FirePdfResult> {
    let own_variant = options.cache_variant();
    let record = |event: &str, variant: &str| {
      span.record("fire_pdf.cache.event", event);
      span.record("fire_pdf.cache.variant", variant);
    };

    let body = serde_json::to_vec(&CacheLookupRequest {
      keys,
      options: CacheLookupOptions {
        mode: options.mode.clone(),
        include_page_markdown: options.page_markdown,
        include_blocks: options.blocks,
        page_markers: options.page_markers,
      },
      team_id: &self.request.team_id,
      kind: "scrape",
      refresh: self.config.cache_refresh_per_minute > 0 && options.refresh,
      source_kind: self.request.source_kind.as_str(),
      scrape_id: &self.request.scrape_id,
    })
    .ok()?;

    let give_up_at = self.io.now_ms() + LOOKUP_TIMEOUT_MS;
    let mut answer = None;
    let mut last_error = String::new();
    for _ in 0..LOOKUP_TRIES {
      let remaining = give_up_at - self.io.now_ms();
      if remaining <= 0 {
        break;
      }
      match self
        .send(
          Method::Post,
          format!("{base_url}/cache/lookup"),
          Some(body.clone()),
          Some(Duration::from_millis(remaining.unsigned_abs())),
        )
        .await
      {
        Ok(response) if response.status < 300 => {
          answer = Some(
            serde_json::from_slice::<CacheLookupOutcome>(&response.body).map_err(|e| e.to_string()),
          );
          break;
        }
        Ok(response) => last_error = format!("status {}", response.status),
        Err(error) => last_error = error,
      }
    }
    let answer = match answer.unwrap_or(Err(last_error)) {
      Ok(answer) => answer,
      Err(error) => {
        record("lookup_error", &own_variant);
        tracing::warn!(error, "FirePDF cache lookup failed, proceeding");
        return None;
      }
    };

    let (outcome, key, variant, campaign, result) = match answer {
      CacheLookupOutcome::Miss { reason } => {
        record(
          if reason == "refresh" {
            "bypass_refresh"
          } else {
            "miss"
          },
          &own_variant,
        );
        return None;
      }
      CacheLookupOutcome::Hit {
        key,
        variant,
        result,
      } => ("hit", key, variant, None, result),
      CacheLookupOutcome::Stale {
        key,
        variant,
        campaign,
        result,
      } => ("stale", key, variant, Some(campaign), result),
    };

    // Never an unusable entry, whatever the service says.
    if (options.page_markdown && result.pages.is_none())
      || (options.blocks && result.blocks.is_none())
      || (options.page_markers && result.page_markers != Some(true))
    {
      record("miss", &own_variant);
      return None;
    }

    record(outcome, &variant);
    span.record("fire_pdf.cache.key", key.as_str());
    tracing::info!(
      cache_variant = variant.as_str(),
      cache_key = key.as_str(),
      outcome,
      campaign = campaign.as_deref(),
      "Using cached FirePDF result"
    );

    let result = *result;
    Some(
      FirePdfResult::new(
        result.markdown,
        result.pages_processed.unwrap_or(options.pages_estimate),
        result.pages.filter(|_| options.page_markdown),
        result.blocks.filter(|_| options.blocks),
      )
      .await,
    )
  }
}

#[cfg(test)]
mod tests {
  use std::time::Duration;

  use serde_json::json;

  use super::super::testing::{FakeIo, Reply, client_for, job_options, test_config, test_request};
  use super::super::{FirePdfConfig, PdfMode};

  fn cache_config() -> FirePdfConfig {
    let mut config = test_config();
    config.cache_base_url = Some("http://fire-pdf-cache.test".to_string());
    config
  }

  fn keys() -> Vec<String> {
    vec!["raw-aa".to_string(), "bb".to_string()]
  }

  #[tokio::test]
  async fn a_hit_is_served_with_rendered_html() {
    let io = FakeIo::new(vec![Reply::json(
      200,
      json!({
        "outcome": "hit", "key": "raw-aa", "variant": "base",
        "result": {"markdown": "# Cached", "pages": [{"page": 1, "markdown": "x"}]}
      }),
    )]);
    let config = cache_config();
    let request = test_request();
    let mut options = job_options();
    options.pages_estimate = 3;
    let result = client_for(&io, &config, &request)
      .lookup_cache(&keys(), &options)
      .await
      .unwrap();
    assert_eq!(result.markdown, "# Cached");
    assert!(result.html.contains("<h1>Cached</h1>"));
    assert_eq!(result.pages_processed, 3);
    assert_eq!(
      result.page_markdown, None,
      "sidecars the request did not ask for are stripped"
    );

    let call = &io.calls()[0];
    assert_eq!(call.url, "http://fire-pdf-cache.test/cache/lookup");
    assert_eq!(call.bearer.as_deref(), Some("secret"));
    assert!(call.timeout.is_some_and(|t| t <= Duration::from_secs(5)));
    assert_eq!(
      call.body.clone().unwrap(),
      json!({
        "keys": ["raw-aa", "bb"], "options": {"mode": "auto"}, "team_id": "team-x",
        "kind": "scrape", "refresh": false, "source_kind": "pdf", "scrape_id": "scrape-id-test"
      })
    );
  }

  #[tokio::test]
  async fn stale_entries_are_served_and_misses_are_not() {
    let config = cache_config();
    let request = test_request();
    let io = FakeIo::new(vec![Reply::json(
      200,
      json!({"outcome": "stale", "key": "bb", "variant": "base", "campaign": "c1", "result": {"markdown": "old", "pages_processed": 2}}),
    )]);
    let result = client_for(&io, &config, &request)
      .lookup_cache(&keys(), &job_options())
      .await
      .unwrap();
    assert_eq!(result.pages_processed, 2);

    let io = FakeIo::new(vec![Reply::json(
      200,
      json!({"outcome": "miss", "reason": "not_found"}),
    )]);
    assert!(
      client_for(&io, &config, &request)
        .lookup_cache(&keys(), &job_options())
        .await
        .is_none()
    );
  }

  #[tokio::test]
  async fn refresh_is_forwarded_only_with_a_budget() {
    let request = test_request();
    let mut options = job_options();
    options.refresh = true;
    for (budget, expected) in [(10, true), (0, false)] {
      let mut config = cache_config();
      config.cache_refresh_per_minute = budget;
      let io = FakeIo::new(vec![Reply::json(
        200,
        json!({"outcome": "miss", "reason": "refresh"}),
      )]);
      client_for(&io, &config, &request)
        .lookup_cache(&keys(), &options)
        .await;
      assert_eq!(io.calls()[0].body.clone().unwrap()["refresh"], expected);
    }
  }

  #[tokio::test]
  async fn never_serves_an_entry_missing_what_the_request_needs() {
    let config = cache_config();
    let request = test_request();
    let mut options = job_options();
    options.page_markdown = true;
    options.page_markers = true;
    for result in [
      json!({"markdown": "x", "page_markers": true}),
      json!({"markdown": "x", "pages": [{"page": 1, "markdown": "x"}]}),
    ] {
      let io = FakeIo::new(vec![Reply::json(
        200,
        json!({"outcome": "hit", "key": "k", "variant": "v", "result": result}),
      )]);
      assert!(
        client_for(&io, &config, &request)
          .lookup_cache(&keys(), &options)
          .await
          .is_none()
      );
      assert_eq!(
        io.calls()[0].body.clone().unwrap()["options"],
        json!({"mode": "auto", "include_page_markdown": true, "page_markers": true})
      );
    }
  }

  #[tokio::test]
  async fn a_failed_lookup_is_a_miss_after_one_retry() {
    let config = cache_config();
    let request = test_request();
    let io = FakeIo::new(vec![Reply::json(500, json!({})), Reply::TransportError]);
    assert!(
      client_for(&io, &config, &request)
        .lookup_cache(&keys(), &job_options())
        .await
        .is_none()
    );
    assert_eq!(io.calls().len(), 2);

    let io = FakeIo::new(vec![Reply::json(200, json!({"outcome": "maybe"}))]);
    assert!(
      client_for(&io, &config, &request)
        .lookup_cache(&keys(), &job_options())
        .await
        .is_none()
    );
    assert_eq!(io.calls().len(), 1, "a malformed answer is not retried");
  }

  #[tokio::test]
  async fn skipped_without_a_service_under_zdr_and_for_uncacheable_requests() {
    let request = test_request();
    let io = FakeIo::new(vec![]);
    assert!(
      client_for(&io, &test_config(), &request)
        .lookup_cache(&keys(), &job_options())
        .await
        .is_none()
    );

    let config = cache_config();
    let mut zdr = test_request();
    zdr.zdr = true;
    assert!(
      client_for(&io, &config, &zdr)
        .lookup_cache(&keys(), &job_options())
        .await
        .is_none()
    );

    let mut fast = job_options();
    fast.mode = PdfMode::Fast;
    let mut capped = job_options();
    capped.max_pages = Some(3);
    for options in [fast, capped] {
      assert!(
        client_for(&io, &config, &request)
          .lookup_cache(&keys(), &options)
          .await
          .is_none()
      );
    }
    assert!(io.calls().is_empty());
  }

  #[test]
  fn cache_variants_follow_the_capability_lattice() {
    let variant = |mode: PdfMode, pages: bool, blocks: bool, markers: bool| {
      let mut options = job_options();
      options.mode = mode;
      options.page_markdown = pages;
      options.blocks = blocks;
      options.page_markers = markers;
      options.cache_variant()
    };
    assert_eq!(variant(PdfMode::Auto, false, false, false), "base");
    assert_eq!(variant(PdfMode::Ocr, false, false, false), "ocr");
    assert_eq!(
      variant(PdfMode::Auto, true, true, false),
      "page-markdown-blocks-v1"
    );
    assert_eq!(variant(PdfMode::Ocr, false, true, false), "ocr-blocks-v1");
    assert_eq!(variant(PdfMode::Auto, false, false, true), "markers-v1");
    assert_eq!(variant(PdfMode::Ocr, false, false, true), "ocr-markers-v1");
    assert_eq!(
      variant(PdfMode::Ocr, true, false, true),
      "ocr-page-markdown-markers-v1"
    );
  }
}
