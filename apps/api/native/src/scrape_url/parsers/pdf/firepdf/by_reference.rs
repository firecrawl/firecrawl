//! Large PDFs (30-256MB) travel to fire-pdf by GCS reference instead of inline
//! base64, and fire-engine can hand them off the same way.

use bytes::Bytes;
use tracing::{Instrument, field::Empty};

use super::super::super::super::{
  error::ScrapeURLError, file_size_limit::FIRE_PDF_BY_REFERENCE_MAX_FILE_SIZE,
  raw_page::BytesOffloaded,
};
use super::{
  FallbackReason, FirePdfClient, FirePdfConfig, FirePdfError, FirePdfJobOptions, FirePdfResult,
  io::{self, GcsObject, GcsReadError},
  jobs::AsyncInput,
  schedule::MIN_ASYNC_CALLER_WINDOW_MS,
  sha256_hex,
};

/// A file fire-engine uploaded to its handoff bucket instead of inlining it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Handoff {
  pub uri: String,
  pub sha256: Option<String>,
  pub size_bytes: usize,
  /// The generation that was read; a copy is pinned to it.
  pub generation: Option<i64>,
}

/// `gs://bucket/key` into its parts.
pub fn parse_gcs_uri(uri: &str) -> Option<(&str, &str)> {
  let (bucket, key) = uri.strip_prefix("gs://")?.split_once('/')?;
  (!bucket.is_empty() && !key.is_empty()).then_some((bucket, key))
}

/// Key of a by-reference input object. The hash prefix spreads time-ordered scrape ids
/// across GCS partitions; the variant keeps transports from racing on one object.
pub fn input_object_key(scrape_id: &str, variant: Option<&str>) -> String {
  let prefix = &sha256_hex(scrape_id.as_bytes())[..8];
  match variant {
    Some(variant) => format!("inputs/{prefix}-{scrape_id}-{variant}.pdf"),
    None => format!("inputs/{prefix}-{scrape_id}.pdf"),
  }
}

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

/// Materializes a fire-engine handoff. Only objects in fire-engine's handoff
/// bucket are read, never a bucket named by response data.
pub async fn download_handoff(
  config: &FirePdfConfig,
  offloaded: &BytesOffloaded,
  max_bytes: usize,
) -> Result<(Bytes, Handoff), ScrapeURLError> {
  let Some((bucket, key)) = parse_gcs_uri(&offloaded.gcs_uri)
    .filter(|(bucket, _)| config.fire_engine_pdf_gcs_bucket.as_deref() == Some(*bucket))
  else {
    tracing::warn!(
      uri = offloaded.gcs_uri.as_str(),
      expected_bucket = config.fire_engine_pdf_gcs_bucket.as_deref(),
      "fire-engine GCS file reference outside the handoff bucket"
    );
    return Err(ScrapeURLError::PDFFetchFailed);
  };
  let max_bytes = max_bytes.min(FIRE_PDF_BY_REFERENCE_MAX_FILE_SIZE);
  let read = io::gcs_read(
    GcsObject {
      bucket: bucket.to_string(),
      key: key.to_string(),
      generation: None,
    },
    i64::try_from(max_bytes).unwrap_or(i64::MAX),
  )
  .await;
  match read {
    Ok(read) => Ok((
      read.bytes.clone(),
      Handoff {
        uri: offloaded.gcs_uri.clone(),
        sha256: offloaded.sha256.clone(),
        size_bytes: read.bytes.len(),
        generation: read.generation,
      },
    )),
    Err(GcsReadError::OverSize(size)) => {
      tracing::warn!(
        uri = offloaded.gcs_uri.as_str(),
        size,
        max_bytes,
        "fire-engine GCS file reference has unusable size"
      );
      Err(ScrapeURLError::UnsupportedFileError {
        reason: "File exceeds size limit".to_string(),
      })
    }
    Err(GcsReadError::Failed(error)) => {
      tracing::warn!(
        uri = offloaded.gcs_uri.as_str(),
        error,
        "fire-engine GCS file download failed"
      );
      Err(ScrapeURLError::PDFFetchFailed)
    }
  }
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
  pub async fn by_reference_attempt(
    &self,
    attempt: ByReferenceAttempt<'_>,
  ) -> Result<Option<FirePdfResult>, FirePdfError> {
    let span = tracing::info_span!(
      "fire_pdf::by_reference",
      file_size_bytes = attempt.bytes.len(),
      fire_pdf.by_reference.cache_hit = Empty,
      fire_pdf.by_reference.adopted = Empty,
      fire_pdf.by_reference.placement = Empty,
    );
    self
      .by_reference_attempt_inner(attempt, &span)
      .instrument(span.clone())
      .await
  }

  async fn by_reference_attempt_inner(
    &self,
    attempt: ByReferenceAttempt<'_>,
    span: &tracing::Span,
  ) -> Result<Option<FirePdfResult>, FirePdfError> {
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

    if let Some(cached) = self.lookup_cache(&[format!("raw-{sha256}")], options).await {
      span.record("fire_pdf.by_reference.cache_hit", true);
      return Ok(Some(cached));
    }

    // Placement can move hundreds of MB; skip it when the async path would refuse the job anyway.
    if let Some(remaining_ms) = self.remaining_ms()
      && remaining_ms < MIN_ASYNC_CALLER_WINDOW_MS
    {
      tracing::warn!(
        remaining_ms,
        "FirePDF by-reference skipped: too little time left for an async job"
      );
      return Err(FirePdfError::Async(FallbackReason::DeadlineTooClose));
    }

    // Retries carry fresh scrape ids, so only a content-level lookup joins them to
    // the job an earlier attempt started and left running.
    if let Some(adopted) = self.lookup_adoptable(&sha256, options).await {
      span.record("fire_pdf.by_reference.adopted", true);
      match self
        .run_async(
          AsyncInput::Adopted {
            scrape_id: &adopted,
            sha256: &sha256,
          },
          options,
        )
        .await
      {
        Ok(result) => return Ok(Some(result)),
        // This caller's own budget is gone; a fresh submit could not succeed either.
        Err(
          error @ FirePdfError::Async(
            FallbackReason::PollingTimeout | FallbackReason::DeadlineTooClose,
          ),
        ) => return Err(error),
        Err(error) => tracing::warn!(
          error = %error,
          adopted_scrape_id = adopted.as_str(),
          "Adopted FirePDF job did not deliver; submitting fresh"
        ),
      }
    }

    let handoff_sha_matches = handoff
      .and_then(|x| x.sha256.as_deref())
      .is_some_and(|x| x.eq_ignore_ascii_case(&sha256));
    if !handoff_sha_matches && handoff.is_some_and(|x| x.sha256.is_some()) {
      tracing::warn!(
        "fire-engine handoff sha256 does not match local bytes; using streaming upload"
      );
    }
    let rewrite_from = handoff.filter(|x| handoff_sha_matches && x.size_bytes == bytes.len());

    let mut gcs_uri = None;
    if let Some(handoff) = rewrite_from {
      gcs_uri = self.rewrite_handoff(handoff, limit_bytes).await;
      if gcs_uri.is_some() {
        span.record("fire_pdf.by_reference.placement", "rewrite");
      }
    }
    if gcs_uri.is_none() {
      // A distinct key when a rewrite was attempted: a timed-out copy may still land.
      gcs_uri = self
        .upload_input(bytes, limit_bytes, rewrite_from.map(|_| "s"))
        .await;
      if gcs_uri.is_some() {
        span.record("fire_pdf.by_reference.placement", "upload");
      }
    }
    let Some(gcs_uri) = gcs_uri else {
      span.record("fire_pdf.by_reference.placement", "failed");
      return Ok(None);
    };

    self
      .run_async(
        AsyncInput::ByReference {
          gcs_uri: &gcs_uri,
          sha256: &sha256,
        },
        options,
      )
      .await
      .map(Some)
      .inspect_err(|error| {
        tracing::error!(
          error = %error,
          file_size_bytes = bytes.len(),
          "FirePDF by-reference scrape failed (no fallback at this size)"
        );
      })
  }

  /// Server-side copy of a fire-engine handoff into fire-pdf's input bucket.
  async fn rewrite_handoff(&self, handoff: &Handoff, limit_bytes: usize) -> Option<String> {
    let (bucket, key) = parse_gcs_uri(&handoff.uri)
      .filter(|(bucket, _)| self.config.fire_engine_pdf_gcs_bucket.as_deref() == Some(*bucket))?;
    if handoff.size_bytes > limit_bytes {
      tracing::warn!(
        size_bytes = handoff.size_bytes,
        limit_bytes,
        "fire-engine PDF handoff exceeds this team's large-PDF limit; refusing rewrite"
      );
      return None;
    }
    let dest_bucket = &self.config.gcs_input_bucket;
    let dest_key = input_object_key(&self.request.scrape_id, None);
    let started_at = io::now_ms();
    let source = GcsObject {
      bucket: bucket.to_string(),
      key: key.to_string(),
      generation: handoff.generation,
    };
    match io::gcs_rewrite(source, dest_bucket.clone(), dest_key.clone()).await {
      Ok(()) => {
        tracing::info!(
          size_bytes = handoff.size_bytes,
          duration_ms = io::now_ms() - started_at,
          "Rewrote fire-engine PDF handoff into fire-pdf inputs"
        );
        Some(format!("gs://{dest_bucket}/{dest_key}"))
      }
      Err(error) => {
        tracing::warn!(
          error,
          "GCS rewrite of fire-engine PDF handoff failed; falling back to streaming upload"
        );
        None
      }
    }
  }

  /// Uploads the PDF into fire-pdf's input bucket. The object is left to the
  /// bucket's lifecycle policy: fire-pdf's retry replay needs it to outlive the job.
  async fn upload_input(
    &self,
    bytes: &Bytes,
    limit_bytes: usize,
    variant: Option<&str>,
  ) -> Option<String> {
    if bytes.len() > limit_bytes {
      tracing::warn!(
        size_bytes = bytes.len(),
        limit_bytes,
        "Large PDF exceeds this team's large-PDF limit; refusing upload"
      );
      return None;
    }
    let bucket = &self.config.gcs_input_bucket;
    let key = input_object_key(&self.request.scrape_id, variant);
    let started_at = io::now_ms();
    match io::gcs_upload(
      bucket.clone(),
      key.clone(),
      bytes.clone(),
      self.request.scrape_id.clone(),
    )
    .await
    {
      Ok(()) => {
        tracing::info!(
          size_bytes = bytes.len(),
          duration_ms = io::now_ms() - started_at,
          "Uploaded large PDF for by-reference FirePDF submit"
        );
        Some(format!("gs://{bucket}/{key}"))
      }
      Err(error) => {
        tracing::warn!(
          error,
          size_bytes = bytes.len(),
          "Large-PDF GCS input upload failed; falling back to legacy handling"
        );
        None
      }
    }
  }
}
