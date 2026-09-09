use std::fmt::Debug;

use google_cloud_storage::client::Storage;
use serde::{Deserialize, Serialize};
use tokio::sync::OnceCell;
use tracing::instrument;
use url::Url;
use uuid::Uuid;

use super::super::error::ScrapeURLError;
use super::super::raw_page::ScrapeProxy;

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
  pub proxy_used: ScrapeProxy,
}

impl IndexGcs {
  #[instrument(name = "IndexGcs::init", err)]
  async fn init() -> Result<Option<(Storage, String)>, ScrapeURLError> {
    let Some(bucket_name) = std::env::var("GCS_INDEX_BUCKET_NAME")
      .ok()
      .filter(|x| !x.is_empty())
    else {
      return Ok(None);
    };

    Ok(Some((
      Storage::builder()
        .build()
        .await
        .map_err(|e| ScrapeURLError::Internal(e.to_string()))?,
      format!("projects/_/buckets/{}", bucket_name),
    )))
  }

  pub async fn get() -> Result<Option<Self>, ScrapeURLError> {
    Ok(
      INDEX_GCS
        .get_or_try_init(Self::init)
        .await?
        .as_ref()
        .map(Self),
    )
  }

  #[instrument(name = "IndexGcs::get_document", err)]
  pub async fn get_document(&self, id: Uuid) -> Result<Option<IndexDocument>, ScrapeURLError> {
    let mut resp = match self
      .0
      .0
      .read_object(&self.0.1, format!("{}.json", id))
      .send()
      .await
    {
      Ok(resp) => resp,
      Err(e) if e.http_status_code() == Some(404) => return Ok(None),
      Err(e) => return Err(e.into()),
    };

    let mut contents = Vec::with_capacity(resp.object().size as usize);
    while let Some(chunk) = resp.next().await {
      contents.extend_from_slice(&chunk?);
    }

    Ok(Some(serde_json::from_slice::<IndexDocument>(&contents)?))
  }
}
