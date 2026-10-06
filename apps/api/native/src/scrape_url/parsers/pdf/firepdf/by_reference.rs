//! Large PDFs (30-256MB) travel to fire-pdf by GCS reference instead of inline base64.

use bytes::Bytes;
use tracing::{Span, field::Empty};

use super::{
  FallbackReason, FirePdfClient, FirePdfConfig, FirePdfError, FirePdfJobOptions, FirePdfResult,
  Handoff, jobs::AsyncInput, schedule::MIN_ASYNC_CALLER_WINDOW_MS, sha256_hex,
};

/// Whether the by-reference route can take this request, judged before the file is
/// fetched. Shared by fire-engine's handoff grant and the parser so they never drift.
/// ZDR is excluded because the input object persists in GCS.
pub fn by_reference_reachable(
  config: &FirePdfConfig,
  fast_mode: bool,
  force_requested: bool,
  zdr: bool,
) -> bool {
  !fast_mode
    && !zdr
    && config.base_url.is_some()
    && (force_requested || (config.enable && config.by_reference_enable))
}

pub struct ByReferenceAttempt<'a> {
  pub bytes: &'a Bytes,
  pub handoff: Option<&'a Handoff>,
  /// `pages_estimate` must be positive: fire-pdf has no bytes to count at admission.
  pub options: &'a FirePdfJobOptions,
  /// The team's large-PDF limit, enforced again by both placements.
  pub limit_bytes: usize,
}

impl FirePdfClient<'_> {
  /// The by-reference attempt for one large PDF, cheapest step first: the raw-sha
  /// cache, adopting a job for the same bytes, then placing the input (server-side
  /// copy of a handoff, else an upload) and submitting fresh.
  ///
  /// `Ok(None)` means the input never reached fire-pdf's bucket. Failures after
  /// placement are errors: no inline route exists at this size.
  #[tracing::instrument(
    name = "FirePdfClient::by_reference_attempt",
    skip_all,
    fields(
      file_size_bytes = attempt.bytes.len(),
      fire_pdf.pages_estimate = attempt.options.pages_estimate,
      fire_pdf.cache_hit = Empty,
      fire_pdf.skipped = Empty,
      fire_pdf.adopted = Empty,
      fire_pdf.adoption_failed = Empty,
      fire_pdf.handoff_sha_matches = Empty,
      fire_pdf.placement = Empty,
    ),
    err
  )]
  pub async fn by_reference_attempt(
    &self,
    attempt: ByReferenceAttempt<'_>,
  ) -> Result<Option<FirePdfResult>, FirePdfError> {
    let span = Span::current();
    let ByReferenceAttempt {
      bytes,
      handoff,
      options,
      limit_bytes,
    } = attempt;

    // The raw-byte sha is the cache identity, the adoption identity, and verifies a handoff.
    let sha256 = {
      let bytes = bytes.clone();
      tokio::task::spawn_blocking(move || sha256_hex(&bytes)).await
    }
    .unwrap_or_else(|_| sha256_hex(bytes));

    let cached = self.lookup_cache(&[format!("raw-{sha256}")], options).await;
    span.record("fire_pdf.cache_hit", cached.is_some());
    if cached.is_some() {
      return Ok(cached);
    }

    // Placement can move hundreds of MB; skip it when the async path would refuse the job anyway.
    if self
      .remaining_ms()
      .is_some_and(|x| x < MIN_ASYNC_CALLER_WINDOW_MS)
    {
      span.record("fire_pdf.skipped", "deadline_too_close");
      return Err(FirePdfError::Async(FallbackReason::DeadlineTooClose));
    }

    if let Some(result) = self.adopt_existing(&sha256, options).await? {
      return Ok(Some(result));
    }
    let Some(gcs_uri) = self.place_input(bytes, handoff, &sha256, limit_bytes).await else {
      span.record("fire_pdf.placement", "failed");
      return Ok(None);
    };
    let input = AsyncInput::ByReference {
      gcs_uri: &gcs_uri,
      sha256: &sha256,
    };
    self.run_async(input, options).await.map(Some)
  }

  /// Retries carry fresh scrape ids, so only a content-level lookup joins them to the
  /// job an earlier attempt started and left running. A dead adopted job means submitting fresh.
  async fn adopt_existing(
    &self,
    sha256: &str,
    options: &FirePdfJobOptions,
  ) -> Result<Option<FirePdfResult>, FirePdfError> {
    let Some(adopted) = self.lookup_adoptable(sha256, options).await else {
      return Ok(None);
    };
    let span = Span::current();
    span.record("fire_pdf.adopted", adopted.as_str());
    let input = AsyncInput::Adopted {
      scrape_id: &adopted,
      sha256,
    };
    match self.run_async(input, options).await {
      Ok(result) => Ok(Some(result)),
      // This caller's own budget is gone; a fresh submit could not succeed either.
      Err(
        error @ FirePdfError::Async(
          FallbackReason::PollingTimeout | FallbackReason::DeadlineTooClose,
        ),
      ) => Err(error),
      Err(error) => {
        span.record("fire_pdf.adoption_failed", true);
        tracing::error!(error = %error);
        Ok(None)
      }
    }
  }

  /// A server-side copy of a matching handoff, else an upload. `None` when both fail.
  async fn place_input(
    &self,
    bytes: &Bytes,
    handoff: Option<&Handoff>,
    sha256: &str,
    limit_bytes: usize,
  ) -> Option<String> {
    let span = Span::current();
    if let Some(handoff_sha) = handoff.and_then(|x| x.sha256.as_deref()) {
      span.record(
        "fire_pdf.handoff_sha_matches",
        handoff_sha.eq_ignore_ascii_case(sha256),
      );
    }
    let handoff_sha_matches = handoff
      .and_then(|x| x.sha256.as_deref())
      .is_some_and(|x| x.eq_ignore_ascii_case(sha256));
    let rewrite_from = handoff.filter(|x| handoff_sha_matches && x.size_bytes == bytes.len());

    if let Some(handoff) = rewrite_from
      && let Some(gcs_uri) = self.rewrite_handoff(handoff, limit_bytes).await
    {
      span.record("fire_pdf.placement", "rewrite");
      return Some(gcs_uri);
    }
    // A distinct key when a rewrite was attempted: a timed-out copy may still land.
    let gcs_uri = self
      .upload_input(bytes, limit_bytes, rewrite_from.map(|_| "s"))
      .await?;
    span.record("fire_pdf.placement", "upload");
    Some(gcs_uri)
  }
}
