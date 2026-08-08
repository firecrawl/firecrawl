use google_cloud_storage::client::Storage;
use serde::{Deserialize, Serialize};
use tokio::sync::OnceCell;
use url::Url;
use uuid::Uuid;

use super::super::EngineScrapeProxy;

static INDEX_GCS: OnceCell<Option<(Storage, String)>> = OnceCell::const_new();

pub struct IndexGcs(&'static (Storage, String));

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexDocument {
  pub url: Url,
  pub html: String,
  pub json: Option<String>,
  pub status_code: u16,
  // pub error: Option<String>,
  pub screenshot: Option<String>,
  // pub pdf_metadata: Option<...>,
  pub content_type: Option<String>,
  // pub postprocessors_used: Vec<...>,
  pub proxy_used: EngineScrapeProxy,
}

impl IndexGcs {
  pub async fn get() -> Option<Self> {
    INDEX_GCS
      .get_or_init(|| async {
        if let Some(bucket_name) = std::env::var("GCS_INDEX_BUCKET_NAME").ok()
          && !bucket_name.is_empty()
          && let Some(storage) = Storage::builder().build().await.ok()
        {
          Some((storage, format!("projects/_/buckets/{}", bucket_name)))
        } else {
          None
        }
      })
      .await
      .as_ref()
      .map(Self)
  }

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
