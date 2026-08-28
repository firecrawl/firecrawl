use serde::Deserialize;

use super::super::{BytesOffloaded, EngineScrapeContent};

#[derive(Deserialize)]
#[serde(untagged)]
pub enum FireEngineScrapeFileContent {
  Base64 {
    /// Base64-encoded file content
    content: String,
  },
  Offloaded {
    /// URI of file on GCS bucket (gs://{bucket name}/{object name})
    gcs_uri: String,

    /// SHA-256 hash of file
    sha256: String,

    /// File size in bytes
    size_bytes: usize,
  },
}

impl From<FireEngineScrapeFileContent> for EngineScrapeContent {
  fn from(value: FireEngineScrapeFileContent) -> Self {
    match value {
      FireEngineScrapeFileContent::Base64 { content } => {
        Self::Bytes(
          base64::engine::Engine::decode(&base64::engine::general_purpose::STANDARD, content)
            .unwrap() // TODO: error handling
            .into(),
        )
      }
      FireEngineScrapeFileContent::Offloaded {
        gcs_uri,
        sha256,
        size_bytes,
      } => Self::BytesOffloaded(BytesOffloaded {
        gcs_uri,
        sha256,
        size_bytes,
      }),
    }
  }
}

#[derive(Deserialize)]
pub struct FireEngineScrapeFile {
  pub name: String,

  #[serde(flatten)]
  pub content: FireEngineScrapeFileContent,
}
