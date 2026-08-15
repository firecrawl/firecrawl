use std::fmt::Debug;

use google_cloud_storage::client::Storage;
use serde::{Deserialize, Serialize};
use tokio::sync::OnceCell;
use tracing::instrument;
use url::Url;
use uuid::Uuid;

use super::super::EngineScrapeProxy;

static INDEX_GCS: OnceCell<Option<(Storage, String)>> = OnceCell::const_new();

pub struct IndexGcs(&'static (Storage, String));

impl Debug for IndexGcs {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    write!(f, "IndexGcs({:?})", self.0.1)
  }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexPDFMetadata {
  pub num_pages: u32,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub total_pages: Option<u32>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub title: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexDocument {
  pub url: Url,
  pub html: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub json: Option<String>,
  pub status_code: u16,
  // pub error: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub screenshot: Option<Url>,

  // Legacy num_pages thing
  #[serde(skip_serializing_if = "Option::is_none")]
  pub num_pages: Option<u32>,

  #[serde(skip_serializing_if = "Option::is_none")]
  pub pdf_metadata: Option<IndexPDFMetadata>,

  #[serde(skip_serializing_if = "Option::is_none")]
  pub content_type: Option<String>,
  // pub postprocessors_used: Vec<...>,
  pub proxy_used: EngineScrapeProxy,
}

impl IndexGcs {
  #[instrument(name = "IndexGcs::init")]
  async fn init() -> Option<(Storage, String)> {
    if let Some(bucket_name) = std::env::var("GCS_INDEX_BUCKET_NAME").ok()
      && !bucket_name.is_empty()
      && let Some(storage) = Storage::builder().build().await.ok()
    {
      Some((storage, format!("projects/_/buckets/{}", bucket_name)))
    } else {
      None
    }
  }

  pub async fn get() -> Option<Self> {
    INDEX_GCS.get_or_init(Self::init).await.as_ref().map(Self)
  }

  #[instrument(name = "IndexGcs::get_document")]
  pub async fn get_document(&self, id: Uuid) -> Option<IndexDocument> {
    let mut resp = self
      .0
      .0
      .read_object(&self.0.1, format!("{}.json", id))
      .send()
      .await
      .ok()?; // TODO: error handling

    let mut contents = Vec::with_capacity(resp.object().size as usize);
    while let Some(chunk) = resp.next().await.transpose().ok()? {
      // TODO: error handling
      contents.extend_from_slice(&chunk);
    }

    serde_json::from_slice::<IndexDocument>(&contents).ok() // TODO: error handling
  }
}
