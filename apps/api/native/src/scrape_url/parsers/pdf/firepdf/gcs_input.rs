//! Moving large PDFs through GCS: fire-engine's handoff in, fire-pdf's input bucket out.

use std::time::Instant;

use bytes::Bytes;
use tracing::{Span, field::Empty};

use super::super::super::super::{
  error::ScrapeURLError, file_size_limit::FIRE_PDF_BY_REFERENCE_MAX_FILE_SIZE,
  raw_page::BytesOffloaded,
};
use super::{
  FirePdfClient, FirePdfConfig,
  io::{self, GcsObject, GcsReadError},
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
fn parse_gcs_uri(uri: &str) -> Option<(&str, &str)> {
  let (bucket, key) = uri.strip_prefix("gs://")?.split_once('/')?;
  (!bucket.is_empty() && !key.is_empty()).then_some((bucket, key))
}

/// Key of a by-reference input object. The hash prefix spreads time-ordered scrape ids
/// across GCS partitions; the variant keeps transports from racing on one object.
fn input_object_key(scrape_id: &str, variant: Option<&str>) -> String {
  let prefix = &sha256_hex(scrape_id.as_bytes())[..8];
  match variant {
    Some(variant) => format!("inputs/{prefix}-{scrape_id}-{variant}.pdf"),
    None => format!("inputs/{prefix}-{scrape_id}.pdf"),
  }
}

fn millis_since(start: Instant) -> u64 {
  u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX)
}

/// Materializes a fire-engine handoff. Only objects in fire-engine's handoff
/// bucket are read, never a bucket named by response data.
#[tracing::instrument(
  name = "parsers::pdf::download_handoff",
  skip_all,
  fields(
    gcs.max_bytes = Empty,
    gcs.size_bytes = Empty,
    gcs.generation = Empty,
    gcs.refused = Empty,
    gcs.error = Empty,
    gcs.duration_ms = Empty,
  ),
  err
)]
pub async fn download_handoff(
  config: &FirePdfConfig,
  offloaded: &BytesOffloaded,
  max_bytes: usize,
) -> Result<(Bytes, Handoff), ScrapeURLError> {
  let span = Span::current();
  let Some((bucket, key)) = parse_gcs_uri(&offloaded.gcs_uri)
    .filter(|(bucket, _)| config.fire_engine_pdf_gcs_bucket.as_deref() == Some(*bucket))
  else {
    span.record("gcs.refused", "outside_handoff_bucket");
    return Err(ScrapeURLError::PDFFetchFailed);
  };
  let max_bytes = max_bytes.min(FIRE_PDF_BY_REFERENCE_MAX_FILE_SIZE);
  span.record("gcs.max_bytes", max_bytes);
  let started = Instant::now();
  let object = GcsObject {
    bucket: bucket.to_string(),
    key: key.to_string(),
    generation: None,
  };
  let read = io::gcs_read(object, i64::try_from(max_bytes).unwrap_or(i64::MAX)).await;
  span.record("gcs.duration_ms", millis_since(started));
  match read {
    Ok(read) => {
      span.record("gcs.size_bytes", read.bytes.len());
      span.record("gcs.generation", read.generation);
      let handoff = Handoff {
        uri: offloaded.gcs_uri.clone(),
        sha256: offloaded.sha256.clone(),
        size_bytes: read.bytes.len(),
        generation: read.generation,
      };
      Ok((read.bytes, handoff))
    }
    Err(GcsReadError::OverSize(size)) => {
      span.record("gcs.size_bytes", size);
      span.record("gcs.refused", "over_size");
      Err(ScrapeURLError::UnsupportedFileError {
        reason: "File exceeds size limit".to_string(),
      })
    }
    Err(GcsReadError::Failed(error)) => {
      span.record("gcs.error", error.as_str());
      Err(ScrapeURLError::PDFFetchFailed)
    }
  }
}

impl FirePdfClient<'_> {
  /// Server-side copy of a fire-engine handoff into fire-pdf's input bucket.
  #[tracing::instrument(
    name = "FirePdfClient::rewrite_handoff",
    skip_all,
    fields(
      gcs.size_bytes = handoff.size_bytes,
      gcs.object = Empty,
      gcs.refused = Empty,
      gcs.duration_ms = Empty,
    )
  )]
  pub(super) async fn rewrite_handoff(
    &self,
    handoff: &Handoff,
    limit_bytes: usize,
  ) -> Option<String> {
    let span = Span::current();
    let (bucket, key) = parse_gcs_uri(&handoff.uri)
      .filter(|(bucket, _)| self.config.fire_engine_pdf_gcs_bucket.as_deref() == Some(*bucket))?;
    if handoff.size_bytes > limit_bytes {
      span.record("gcs.refused", "over_team_limit");
      return None;
    }
    let dest_bucket = self.config.gcs_input_bucket.clone();
    let dest_key = input_object_key(&self.request.scrape_id, None);
    span.record("gcs.object", dest_key.as_str());
    let source = GcsObject {
      bucket: bucket.to_string(),
      key: key.to_string(),
      generation: handoff.generation,
    };
    let started = Instant::now();
    let copied = io::gcs_rewrite(source, dest_bucket.clone(), dest_key.clone()).await;
    span.record("gcs.duration_ms", millis_since(started));
    match copied {
      Ok(()) => Some(format!("gs://{dest_bucket}/{dest_key}")),
      Err(error) => {
        tracing::error!(error = %error, "handoff rewrite failed");
        None
      }
    }
  }

  /// Uploads the PDF into fire-pdf's input bucket. The object is left to the
  /// bucket's lifecycle policy: fire-pdf's retry replay needs it to outlive the job.
  #[tracing::instrument(
    name = "FirePdfClient::upload_input",
    skip_all,
    fields(
      gcs.size_bytes = bytes.len(),
      gcs.object = Empty,
      gcs.refused = Empty,
      gcs.duration_ms = Empty,
    )
  )]
  pub(super) async fn upload_input(
    &self,
    bytes: &Bytes,
    limit_bytes: usize,
    variant: Option<&str>,
  ) -> Option<String> {
    let span = Span::current();
    if bytes.len() > limit_bytes {
      span.record("gcs.refused", "over_team_limit");
      return None;
    }
    let bucket = self.config.gcs_input_bucket.clone();
    let key = input_object_key(&self.request.scrape_id, variant);
    span.record("gcs.object", key.as_str());
    let started = Instant::now();
    let uploaded = io::gcs_upload(
      bucket.clone(),
      key.clone(),
      bytes.clone(),
      self.request.scrape_id.clone(),
    )
    .await;
    span.record("gcs.duration_ms", millis_since(started));
    match uploaded {
      Ok(()) => Some(format!("gs://{bucket}/{key}")),
      Err(error) => {
        tracing::error!(error = %error, "input upload failed");
        None
      }
    }
  }
}
