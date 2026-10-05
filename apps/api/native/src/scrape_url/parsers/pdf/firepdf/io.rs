use std::{
  collections::hash_map::RandomState,
  future::Future,
  hash::{BuildHasher, Hasher},
  sync::LazyLock,
  time::{Duration, SystemTime, UNIX_EPOCH},
};

use bytes::Bytes;
use google_cloud_storage::client::{Storage, StorageControl};
use tokio::sync::OnceCell;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
  Get,
  Post,
  Delete,
}

#[derive(Debug, Clone)]
pub struct HttpRequest {
  pub method: Method,
  pub url: String,
  pub bearer: Option<String>,
  /// Serialized JSON body.
  pub json: Option<Vec<u8>>,
  pub timeout: Option<Duration>,
}

#[derive(Debug, Clone)]
pub struct HttpResponse {
  pub status: u16,
  pub body: Bytes,
}

impl HttpResponse {
  /// The body as JSON, or `{}` when it is not JSON (fire-pdf error bodies are best-effort).
  pub fn json_or_empty(&self) -> serde_json::Value {
    serde_json::from_slice(&self.body)
      .unwrap_or_else(|_| serde_json::Value::Object(Default::default()))
  }
}

pub struct GcsObjectRef<'a> {
  pub bucket: &'a str,
  pub key: &'a str,
  pub generation: Option<i64>,
}

pub struct GcsRead {
  pub bytes: Bytes,
  pub generation: Option<i64>,
}

#[derive(Debug)]
pub enum GcsReadError {
  OverSize(i64),
  Failed(String),
}

/// Everything the FirePDF client does to the outside world. Tests drive the
/// client on a virtual clock with a scripted fire-pdf.
pub trait FirePdfIo: Sync {
  /// Epoch milliseconds.
  fn now_ms(&self) -> i64;

  /// Uniform in `[0, 1)`.
  fn random(&self) -> f64;

  fn sleep(&self, ms: i64) -> impl Future<Output = ()> + Send;

  fn send(&self, request: HttpRequest)
  -> impl Future<Output = Result<HttpResponse, String>> + Send;

  /// Reads a whole object, refusing it before the body is read when it is larger than `max_bytes`.
  fn gcs_read(
    &self,
    object: GcsObjectRef<'_>,
    max_bytes: i64,
  ) -> impl Future<Output = Result<GcsRead, GcsReadError>> + Send;

  /// Server-side copy of `source` into `dest_bucket/dest_key`.
  fn gcs_rewrite(
    &self,
    source: GcsObjectRef<'_>,
    dest_bucket: &str,
    dest_key: &str,
  ) -> impl Future<Output = Result<(), String>> + Send;

  fn gcs_upload(
    &self,
    bucket: &str,
    key: &str,
    bytes: Bytes,
    scrape_id: &str,
  ) -> impl Future<Output = Result<(), String>> + Send;
}

static HTTP_CLIENT: LazyLock<Option<reqwest::Client>> =
  LazyLock::new(|| reqwest::Client::builder().build().ok());

static GCS: OnceCell<(Storage, StorageControl)> = OnceCell::const_new();

/// Downloading or uploading 256MB in-cluster is seconds; these bound a stuck stream.
const GCS_TRANSFER_TIMEOUT: Duration = Duration::from_secs(120);
/// Server-side rewrites are metadata-speed regardless of object size.
const GCS_REWRITE_TIMEOUT: Duration = Duration::from_secs(30);
/// Bounds the rewrite-token loop of a cross-location copy.
const GCS_REWRITE_MAX_CALLS: usize = 64;

async fn gcs() -> Result<&'static (Storage, StorageControl), String> {
  GCS
    .get_or_try_init(|| async {
      let storage = Storage::builder()
        .build()
        .await
        .map_err(|e| e.to_string())?;
      let control = StorageControl::builder()
        .build()
        .await
        .map_err(|e| e.to_string())?;
      Ok((storage, control))
    })
    .await
}

fn bucket_path(bucket: &str) -> String {
  format!("projects/_/buckets/{bucket}")
}

pub async fn send_http(request: HttpRequest) -> Result<HttpResponse, String> {
  let Some(client) = HTTP_CLIENT.as_ref() else {
    return Err("HTTP client unavailable".to_string());
  };
  let mut builder = match request.method {
    Method::Get => client.get(&request.url),
    Method::Post => client.post(&request.url),
    Method::Delete => client.delete(&request.url),
  };
  if let Some(bearer) = &request.bearer {
    builder = builder.bearer_auth(bearer);
  }
  if let Some(json) = request.json {
    builder = builder
      .header(reqwest::header::CONTENT_TYPE, "application/json")
      .body(json);
  }
  if let Some(timeout) = request.timeout {
    builder = builder.timeout(timeout);
  }
  let response = builder.send().await.map_err(|e| e.to_string())?;
  let status = response.status().as_u16();
  let body = response.bytes().await.unwrap_or_default();
  Ok(HttpResponse { status, body })
}

/// The production [`FirePdfIo`].
pub struct RealIo;

impl FirePdfIo for RealIo {
  fn now_ms(&self) -> i64 {
    SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
      .unwrap_or(0)
  }

  fn random(&self) -> f64 {
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u64(self.now_ms().unsigned_abs());
    (hasher.finish() >> 11) as f64 / (1u64 << 53) as f64
  }

  async fn sleep(&self, ms: i64) {
    tokio::time::sleep(Duration::from_millis(ms.max(0).unsigned_abs())).await;
  }

  async fn send(&self, request: HttpRequest) -> Result<HttpResponse, String> {
    send_http(request).await
  }

  async fn gcs_read(
    &self,
    object: GcsObjectRef<'_>,
    max_bytes: i64,
  ) -> Result<GcsRead, GcsReadError> {
    let (storage, _) = gcs().await.map_err(GcsReadError::Failed)?;
    let read = async {
      let mut builder = storage.read_object(bucket_path(object.bucket), object.key);
      if let Some(generation) = object.generation {
        builder = builder.set_generation(generation);
      }
      let mut response = builder
        .send()
        .await
        .map_err(|e| GcsReadError::Failed(e.to_string()))?;
      let highlights = response.object();
      if highlights.size <= 0 || highlights.size > max_bytes {
        return Err(GcsReadError::OverSize(highlights.size));
      }
      let mut contents = Vec::with_capacity(usize::try_from(highlights.size).unwrap_or(0));
      while let Some(chunk) = response.next().await {
        let chunk = chunk.map_err(|e| GcsReadError::Failed(e.to_string()))?;
        contents.extend_from_slice(&chunk);
        if i64::try_from(contents.len()).unwrap_or(i64::MAX) > max_bytes {
          return Err(GcsReadError::OverSize(highlights.size));
        }
      }
      Ok(GcsRead {
        bytes: contents.into(),
        generation: Some(highlights.generation),
      })
    };
    tokio::time::timeout(GCS_TRANSFER_TIMEOUT, read)
      .await
      .unwrap_or_else(|_| Err(GcsReadError::Failed("GCS download timed out".to_string())))
  }

  async fn gcs_rewrite(
    &self,
    source: GcsObjectRef<'_>,
    dest_bucket: &str,
    dest_key: &str,
  ) -> Result<(), String> {
    let (_, control) = gcs().await?;
    let rewrite = async {
      let mut token = String::new();
      for _ in 0..GCS_REWRITE_MAX_CALLS {
        let mut builder = control
          .rewrite_object()
          .set_source_bucket(bucket_path(source.bucket))
          .set_source_object(source.key)
          .set_destination_bucket(bucket_path(dest_bucket))
          .set_destination_name(dest_key)
          .set_rewrite_token(token.clone());
        if let Some(generation) = source.generation {
          builder = builder.set_source_generation(generation);
        }
        let response = builder.send().await.map_err(|e| e.to_string())?;
        if response.done {
          return Ok(());
        }
        token = response.rewrite_token;
      }
      Err("GCS rewrite did not finish".to_string())
    };
    tokio::time::timeout(GCS_REWRITE_TIMEOUT, rewrite)
      .await
      .unwrap_or_else(|_| Err("GCS rewrite timed out".to_string()))
  }

  async fn gcs_upload(
    &self,
    bucket: &str,
    key: &str,
    bytes: Bytes,
    scrape_id: &str,
  ) -> Result<(), String> {
    let (storage, _) = gcs().await?;
    let upload = storage
      .write_object(bucket_path(bucket), key, bytes)
      .set_content_type("application/pdf")
      .set_metadata([("scrape_id", scrape_id), ("source", "firecrawl")])
      .send_buffered();
    match tokio::time::timeout(GCS_TRANSFER_TIMEOUT, upload).await {
      Ok(Ok(_)) => Ok(()),
      Ok(Err(e)) => Err(e.to_string()),
      Err(_) => Err("GCS upload timed out".to_string()),
    }
  }
}
