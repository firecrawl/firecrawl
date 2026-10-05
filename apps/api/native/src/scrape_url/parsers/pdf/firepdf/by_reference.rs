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
  io::{FirePdfIo, GcsObjectRef, GcsReadError},
  jobs::AsyncInput,
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
  io: &impl FirePdfIo,
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
  let read = io
    .gcs_read(
      GcsObjectRef {
        bucket,
        key,
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

impl<I: FirePdfIo> FirePdfClient<'_, I> {
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
    let started_at = self.io.now_ms();
    let source = GcsObjectRef {
      bucket,
      key,
      generation: handoff.generation,
    };
    match self.io.gcs_rewrite(source, dest_bucket, &dest_key).await {
      Ok(()) => {
        tracing::info!(
          size_bytes = handoff.size_bytes,
          duration_ms = self.io.now_ms() - started_at,
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
    let started_at = self.io.now_ms();
    match self
      .io
      .gcs_upload(bucket, &key, bytes.clone(), &self.request.scrape_id)
      .await
    {
      Ok(()) => {
        tracing::info!(
          size_bytes = bytes.len(),
          duration_ms = self.io.now_ms() - started_at,
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

#[cfg(test)]
mod tests {
  use serde_json::json;

  use super::super::testing::{
    FakeIo, GcsCall, Reply, client_for, job_options, test_config, test_request,
  };
  use super::super::{FirePdfRequest, io::Method};
  use super::*;

  const MB: usize = 1024 * 1024;

  #[test]
  fn gcs_uris_and_object_keys() {
    assert_eq!(
      parse_gcs_uri("gs://bucket/a/b.pdf"),
      Some(("bucket", "a/b.pdf"))
    );
    assert_eq!(parse_gcs_uri("gs://bucket/"), None);
    assert_eq!(parse_gcs_uri("gs:///key"), None);
    assert_eq!(parse_gcs_uri("https://bucket/key"), None);
    let prefix = &sha256_hex(b"scrape-1")[..8];
    assert_eq!(
      input_object_key("scrape-1", None),
      format!("inputs/{prefix}-scrape-1.pdf")
    );
    assert_eq!(
      input_object_key("scrape-1", Some("s")),
      format!("inputs/{prefix}-scrape-1-s.pdf")
    );
  }

  #[test]
  fn reachability() {
    let config = test_config();
    assert!(by_reference_reachable(&config, false, false, false));
    assert!(
      !by_reference_reachable(&config, true, true, false),
      "fast mode"
    );
    assert!(!by_reference_reachable(&config, false, true, true), "zdr");
    let mut disabled = test_config();
    disabled.by_reference_enable = false;
    assert!(!by_reference_reachable(&disabled, false, false, false));
    assert!(
      by_reference_reachable(&disabled, false, true, false),
      "forced FirePDF only needs the base URL"
    );
    let mut master_off = test_config();
    master_off.enable = false;
    assert!(!by_reference_reachable(&master_off, false, false, false));
    assert!(by_reference_reachable(&master_off, false, true, false));
    let mut unconfigured = test_config();
    unconfigured.base_url = None;
    assert!(!by_reference_reachable(&unconfigured, false, true, false));
  }

  fn offloaded(uri: &str) -> BytesOffloaded {
    BytesOffloaded {
      gcs_uri: uri.to_string(),
      sha256: Some("abc".to_string()),
      size_bytes: Some(4),
    }
  }

  #[tokio::test]
  async fn handoff_downloads_only_from_the_allowlisted_bucket() {
    let mut io = FakeIo::new(vec![]);
    io.stored_object = Some(Bytes::from_static(b"%PDF"));
    let config = test_config();

    let (bytes, handoff) = download_handoff(&io, &config, &offloaded("gs://fe-handoff/x.pdf"), 10)
      .await
      .unwrap();
    assert_eq!(bytes, Bytes::from_static(b"%PDF"));
    assert_eq!(
      handoff,
      Handoff {
        uri: "gs://fe-handoff/x.pdf".to_string(),
        sha256: Some("abc".to_string()),
        size_bytes: 4,
        generation: Some(7),
      }
    );

    assert!(matches!(
      download_handoff(&io, &config, &offloaded("gs://elsewhere/x.pdf"), 10).await,
      Err(ScrapeURLError::PDFFetchFailed)
    ));
    let mut unconfigured = test_config();
    unconfigured.fire_engine_pdf_gcs_bucket = None;
    assert!(matches!(
      download_handoff(&io, &unconfigured, &offloaded("gs://fe-handoff/x.pdf"), 10).await,
      Err(ScrapeURLError::PDFFetchFailed)
    ));
    assert_eq!(io.gcs_calls().len(), 1, "refused references are never read");

    assert!(matches!(
      download_handoff(&io, &config, &offloaded("gs://fe-handoff/x.pdf"), 3).await,
      Err(ScrapeURLError::UnsupportedFileError { .. })
    ));
  }

  fn large_options() -> FirePdfJobOptions {
    let mut options = job_options();
    options.pages_estimate = 40;
    options
  }

  fn request() -> FirePdfRequest {
    let mut request = test_request();
    request.deadline_ms = Some(super::super::testing::T0 + 120_000);
    request
  }

  fn async_success() -> Vec<Reply> {
    vec![
      Reply::json(404, json!({})),
      Reply::json(
        202,
        json!({"scrape_id": "scrape-id-test", "status": "queued"}),
      ),
      Reply::json(
        200,
        json!({"scrape_id": "scrape-id-test", "status": "done"}),
      ),
      Reply::json(200, json!({"markdown": "# large"})),
    ]
  }

  fn handoff_for(bytes: &Bytes) -> Handoff {
    Handoff {
      uri: "gs://fe-handoff/big.pdf".to_string(),
      sha256: Some(sha256_hex(bytes).to_uppercase()),
      size_bytes: bytes.len(),
      generation: Some(42),
    }
  }

  #[tokio::test]
  async fn rewrites_a_matching_handoff_and_submits_by_reference() {
    let io = FakeIo::new(async_success());
    let config = test_config();
    let request = request();
    let bytes = Bytes::from_static(b"%PDF-large");
    let handoff = handoff_for(&bytes);
    let result = client_for(&io, &config, &request)
      .by_reference_attempt(ByReferenceAttempt {
        bytes: &bytes,
        handoff: Some(&handoff),
        options: &large_options(),
        limit_bytes: 50 * MB,
      })
      .await
      .unwrap()
      .unwrap();
    assert_eq!(result.markdown, "# large");

    let key = input_object_key("scrape-id-test", None);
    assert_eq!(
      io.gcs_calls(),
      vec![GcsCall::Rewrite {
        source: "fe-handoff/big.pdf".to_string(),
        generation: Some(42),
        dest: format!("fire-pdf-inputs/{key}"),
      }]
    );
    let calls = io.calls();
    assert_eq!(calls[0].url, "http://fire-pdf.test/jobs/lookup");
    assert_eq!(
      calls[0].body.clone().unwrap()["input_sha256"],
      sha256_hex(&bytes)
    );
    let submit = calls[1].body.clone().unwrap();
    assert_eq!(
      submit["input_gcs_uri"],
      format!("gs://fire-pdf-inputs/{key}")
    );
    assert_eq!(submit["input_sha256"], sha256_hex(&bytes));
    assert_eq!(submit["options"]["pages_estimate"], 40);
  }

  #[tokio::test]
  async fn uploads_when_the_handoff_does_not_match_or_the_rewrite_fails() {
    let config = test_config();
    let request = request();
    let bytes = Bytes::from_static(b"%PDF-large");

    let io = FakeIo::new(async_success());
    let mut mismatched = handoff_for(&bytes);
    mismatched.sha256 = Some("0000".to_string());
    client_for(&io, &config, &request)
      .by_reference_attempt(ByReferenceAttempt {
        bytes: &bytes,
        handoff: Some(&mismatched),
        options: &large_options(),
        limit_bytes: 50 * MB,
      })
      .await
      .unwrap()
      .unwrap();
    assert_eq!(
      io.gcs_calls(),
      vec![GcsCall::Upload {
        dest: format!(
          "fire-pdf-inputs/{}",
          input_object_key("scrape-id-test", None)
        ),
        len: bytes.len(),
      }]
    );

    let mut io = FakeIo::new(async_success());
    io.rewrite_ok = false;
    let handoff = handoff_for(&bytes);
    client_for(&io, &config, &request)
      .by_reference_attempt(ByReferenceAttempt {
        bytes: &bytes,
        handoff: Some(&handoff),
        options: &large_options(),
        limit_bytes: 50 * MB,
      })
      .await
      .unwrap()
      .unwrap();
    let calls = io.gcs_calls();
    assert!(matches!(calls[0], GcsCall::Rewrite { .. }));
    assert_eq!(
      calls[1],
      GcsCall::Upload {
        dest: format!(
          "fire-pdf-inputs/{}",
          input_object_key("scrape-id-test", Some("s"))
        ),
        len: bytes.len(),
      }
    );
  }

  #[tokio::test]
  async fn falls_through_when_the_input_cannot_be_placed() {
    let config = test_config();
    let request = request();
    let bytes = Bytes::from_static(b"%PDF-large");

    let mut io = FakeIo::new(vec![Reply::json(404, json!({}))]);
    io.upload_ok = false;
    let attempt = client_for(&io, &config, &request)
      .by_reference_attempt(ByReferenceAttempt {
        bytes: &bytes,
        handoff: None,
        options: &large_options(),
        limit_bytes: 50 * MB,
      })
      .await
      .unwrap();
    assert!(attempt.is_none());

    let io = FakeIo::new(vec![Reply::json(404, json!({}))]);
    let handoff = handoff_for(&bytes);
    let attempt = client_for(&io, &config, &request)
      .by_reference_attempt(ByReferenceAttempt {
        bytes: &bytes,
        handoff: Some(&handoff),
        options: &large_options(),
        limit_bytes: 4,
      })
      .await
      .unwrap();
    assert!(attempt.is_none(), "both placements enforce the team cap");
    assert!(io.gcs_calls().is_empty());
  }

  #[tokio::test]
  async fn adopts_a_live_job_for_the_same_bytes_instead_of_uploading() {
    let io = FakeIo::new(vec![
      Reply::json(
        200,
        json!({"scrape_id": "earlier-attempt", "status": "running"}),
      ),
      Reply::json(
        200,
        json!({"scrape_id": "earlier-attempt", "status": "done"}),
      ),
      Reply::json(200, json!({"markdown": "# adopted"})),
    ]);
    let config = test_config();
    let request = request();
    let bytes = Bytes::from_static(b"%PDF-large");
    let result = client_for(&io, &config, &request)
      .by_reference_attempt(ByReferenceAttempt {
        bytes: &bytes,
        handoff: None,
        options: &large_options(),
        limit_bytes: 50 * MB,
      })
      .await
      .unwrap()
      .unwrap();
    assert_eq!(result.markdown, "# adopted");
    assert!(io.gcs_calls().is_empty());
    assert_eq!(
      io.calls()[1].url,
      "http://fire-pdf.test/jobs/earlier-attempt"
    );
  }

  #[tokio::test]
  async fn a_dead_adopted_job_falls_through_to_a_fresh_submit() {
    let mut replies = vec![
      Reply::json(200, json!({"scrape_id": "earlier-attempt"})),
      Reply::json(
        410,
        json!({"scrape_id": "earlier-attempt", "status": "expired"}),
      ),
    ];
    replies.extend(async_success().into_iter().skip(1));
    let io = FakeIo::new(replies);
    let config = test_config();
    let request = request();
    let bytes = Bytes::from_static(b"%PDF-large");
    let result = client_for(&io, &config, &request)
      .by_reference_attempt(ByReferenceAttempt {
        bytes: &bytes,
        handoff: None,
        options: &large_options(),
        limit_bytes: 50 * MB,
      })
      .await
      .unwrap()
      .unwrap();
    assert_eq!(result.markdown, "# large");
    assert_eq!(io.gcs_calls().len(), 1);
    assert_eq!(io.calls()[2].method, Method::Post);
  }

  #[tokio::test]
  async fn a_raw_sha_cache_hit_skips_adoption_and_upload() {
    let io = FakeIo::new(vec![Reply::json(
      200,
      json!({"outcome": "hit", "key": "raw-x", "variant": "base", "result": {"markdown": "# cached"}}),
    )]);
    let mut config = test_config();
    config.cache_base_url = Some("http://fire-pdf-cache.test".to_string());
    let request = request();
    let bytes = Bytes::from_static(b"%PDF-large");
    let result = client_for(&io, &config, &request)
      .by_reference_attempt(ByReferenceAttempt {
        bytes: &bytes,
        handoff: None,
        options: &large_options(),
        limit_bytes: 50 * MB,
      })
      .await
      .unwrap()
      .unwrap();
    assert_eq!(result.markdown, "# cached");
    assert_eq!(io.calls().len(), 1);
    assert_eq!(
      io.calls()[0].body.clone().unwrap()["keys"],
      json!([format!("raw-{}", sha256_hex(&bytes))])
    );
  }

  #[tokio::test]
  async fn failures_after_placement_surface_as_errors() {
    let io = FakeIo::new(vec![
      Reply::json(404, json!({})),
      Reply::json(
        202,
        json!({"scrape_id": "scrape-id-test", "status": "queued"}),
      ),
      Reply::json(
        502,
        json!({"scrape_id": "scrape-id-test", "status": "failed"}),
      ),
    ]);
    let config = test_config();
    let request = request();
    let bytes = Bytes::from_static(b"%PDF-large");
    let error = client_for(&io, &config, &request)
      .by_reference_attempt(ByReferenceAttempt {
        bytes: &bytes,
        handoff: None,
        options: &large_options(),
        limit_bytes: 50 * MB,
      })
      .await
      .unwrap_err();
    assert!(matches!(
      error,
      FirePdfError::Async(FallbackReason::TerminalFailed)
    ));
  }
}
