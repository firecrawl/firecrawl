//! Cached FirePDF results, looked up through fire-pdf's cache service. The
//! service applies the read-time rules and the `refresh` budget, and fire-pdf
//! writes the entries itself.

use std::time::Duration;

use tracing::{Instrument, field::Empty};

use super::{
  FirePdfClient, FirePdfJobOptions, FirePdfResult,
  io::{self, Method},
  schema::{CacheLookupOptions, CacheLookupOutcome, CacheLookupRequest},
};

/// The service's own read bound; past it the lookup is a miss and the document is parsed.
const LOOKUP_TIMEOUT_MS: i64 = 5_000;
/// One retry within the same bound covers a connection dropped before it was handled.
const LOOKUP_TRIES: u32 = 2;

impl FirePdfClient<'_> {
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

    let give_up_at = io::now_ms() + LOOKUP_TIMEOUT_MS;
    let mut answer = None;
    let mut last_error = String::new();
    for _ in 0..LOOKUP_TRIES {
      let remaining = give_up_at - io::now_ms();
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
