//! FirePDF client: the sync `/ocr` endpoint, async `/jobs` with polling, the
//! content cache service, and large-PDF submits by GCS reference.

use sha2::{Digest, Sha256};

mod by_reference;
mod cache;
mod client;
mod config;
mod error;
mod gcs_input;
mod io;
mod jobs;
mod routing;
mod schedule;
mod schema;
mod sync;

pub use self::{
  by_reference::{ByReferenceAttempt, by_reference_reachable},
  client::{FirePdfClient, FirePdfJobOptions, FirePdfRequest, FirePdfResult},
  config::FirePdfConfig,
  error::{FallbackReason, FirePdfError},
  gcs_input::{Handoff, download_handoff},
  io::now_ms,
  jobs::AsyncInput,
  routing::{AsyncRouteInput, RouteRecord, decide_async_route, features_label},
  schema::{WirePage, WirePageBlocks},
};

/// Lowercase hex sha-256.
pub fn sha256_hex(bytes: &[u8]) -> String {
  hex::encode(Sha256::digest(bytes))
}
