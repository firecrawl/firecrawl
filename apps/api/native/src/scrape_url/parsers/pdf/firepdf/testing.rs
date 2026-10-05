//! A scripted fire-pdf on a virtual clock, for the client tests.

use std::{
  collections::{HashSet, VecDeque},
  sync::{
    Mutex,
    atomic::{AtomicI64, Ordering},
  },
  time::Duration,
};

use bytes::Bytes;
use serde_json::Value;

use super::super::PdfMode;
use super::{
  FirePdfClient, FirePdfConfig, FirePdfJobOptions, FirePdfRequest, SourceKind,
  io::{FirePdfIo, GcsObjectRef, GcsRead, GcsReadError, HttpRequest, HttpResponse, Method},
};

pub const T0: i64 = 1_000_000_000_000;

pub enum Reply {
  Json(u16, Value),
  TransportError,
}

impl Reply {
  pub fn json(status: u16, body: Value) -> Self {
    Self::Json(status, body)
  }
}

#[derive(Debug, Clone)]
pub struct RecordedCall {
  pub method: Method,
  pub url: String,
  pub bearer: Option<String>,
  pub body: Option<Value>,
  pub timeout: Option<Duration>,
}

type Responder = Box<dyn FnMut(&RecordedCall, &AtomicI64) -> Reply + Send>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GcsCall {
  Read {
    source: String,
  },
  Rewrite {
    source: String,
    generation: Option<i64>,
    dest: String,
  },
  Upload {
    dest: String,
    len: usize,
  },
}

pub struct FakeIo {
  now: AtomicI64,
  pub random: f64,
  responder: Mutex<Responder>,
  calls: Mutex<Vec<RecordedCall>>,
  sleeps: Mutex<Vec<i64>>,
  pub rewrite_ok: bool,
  pub upload_ok: bool,
  /// The object `gcs_read` serves, at generation 7.
  pub stored_object: Option<Bytes>,
  gcs_calls: Mutex<Vec<GcsCall>>,
}

impl FakeIo {
  /// Answers requests from `replies` in order; running out is a transport error.
  pub fn new(replies: Vec<Reply>) -> Self {
    let mut queue: VecDeque<Reply> = replies.into();
    Self::with_responder(move |_, _| queue.pop_front().unwrap_or(Reply::TransportError))
  }

  /// Answers each request with `responder`, which may advance the clock.
  pub fn with_responder(
    responder: impl FnMut(&RecordedCall, &AtomicI64) -> Reply + Send + 'static,
  ) -> Self {
    Self {
      now: AtomicI64::new(T0),
      random: 0.0,
      responder: Mutex::new(Box::new(responder)),
      calls: Mutex::new(Vec::new()),
      sleeps: Mutex::new(Vec::new()),
      rewrite_ok: true,
      upload_ok: true,
      stored_object: None,
      gcs_calls: Mutex::new(Vec::new()),
    }
  }

  pub fn calls(&self) -> Vec<RecordedCall> {
    self.calls.lock().unwrap().clone()
  }

  pub fn urls(&self) -> Vec<String> {
    self.calls().into_iter().map(|c| c.url).collect()
  }

  pub fn sleeps(&self) -> Vec<i64> {
    self.sleeps.lock().unwrap().clone()
  }

  pub fn gcs_calls(&self) -> Vec<GcsCall> {
    self.gcs_calls.lock().unwrap().clone()
  }

  pub fn elapsed(&self) -> i64 {
    self.now_ms() - T0
  }
}

impl FirePdfIo for FakeIo {
  fn now_ms(&self) -> i64 {
    self.now.load(Ordering::SeqCst)
  }

  fn random(&self) -> f64 {
    self.random
  }

  async fn sleep(&self, ms: i64) {
    self.sleeps.lock().unwrap().push(ms);
    self.now.fetch_add(ms, Ordering::SeqCst);
  }

  async fn send(&self, request: HttpRequest) -> Result<HttpResponse, String> {
    let call = RecordedCall {
      method: request.method,
      url: request.url,
      bearer: request.bearer,
      body: request
        .json
        .as_ref()
        .map(|x| serde_json::from_slice(x).unwrap()),
      timeout: request.timeout,
    };
    self.calls.lock().unwrap().push(call.clone());
    let reply = (self.responder.lock().unwrap())(&call, &self.now);
    match reply {
      Reply::Json(status, body) => Ok(HttpResponse {
        status,
        body: Bytes::from(serde_json::to_vec(&body).unwrap()),
      }),
      Reply::TransportError => Err("connection reset".to_string()),
    }
  }

  async fn gcs_read(
    &self,
    object: GcsObjectRef<'_>,
    max_bytes: i64,
  ) -> Result<GcsRead, GcsReadError> {
    self.gcs_calls.lock().unwrap().push(GcsCall::Read {
      source: format!("{}/{}", object.bucket, object.key),
    });
    let Some(bytes) = self.stored_object.clone() else {
      return Err(GcsReadError::Failed("no such object".to_string()));
    };
    if bytes.len() as i64 > max_bytes {
      return Err(GcsReadError::OverSize(bytes.len() as i64));
    }
    Ok(GcsRead {
      bytes,
      generation: Some(7),
    })
  }

  async fn gcs_rewrite(
    &self,
    source: GcsObjectRef<'_>,
    dest_bucket: &str,
    dest_key: &str,
  ) -> Result<(), String> {
    self.gcs_calls.lock().unwrap().push(GcsCall::Rewrite {
      source: format!("{}/{}", source.bucket, source.key),
      generation: source.generation,
      dest: format!("{dest_bucket}/{dest_key}"),
    });
    if self.rewrite_ok {
      Ok(())
    } else {
      Err("rewrite failed".to_string())
    }
  }

  async fn gcs_upload(
    &self,
    bucket: &str,
    key: &str,
    bytes: Bytes,
    _scrape_id: &str,
  ) -> Result<(), String> {
    self.gcs_calls.lock().unwrap().push(GcsCall::Upload {
      dest: format!("{bucket}/{key}"),
      len: bytes.len(),
    });
    if self.upload_ok {
      Ok(())
    } else {
      Err("upload failed".to_string())
    }
  }
}

pub fn test_config() -> FirePdfConfig {
  FirePdfConfig {
    enable: true,
    base_url: Some("http://fire-pdf.test".to_string()),
    api_key: Some("secret".to_string()),
    cache_base_url: None,
    cache_refresh_per_minute: 10,
    async_percent: 0.0,
    async_bulk_origin_percent: 0.0,
    async_force_team_ids: HashSet::new(),
    async_disable_team_ids: HashSet::new(),
    async_allow_request_override: false,
    async_wait_ms: 0,
    by_reference_enable: true,
    gcs_input_bucket: "fire-pdf-inputs".to_string(),
    fire_engine_pdf_gcs_bucket: Some("fe-handoff".to_string()),
  }
}

pub fn test_request() -> FirePdfRequest {
  FirePdfRequest {
    scrape_id: "scrape-id-test".to_string(),
    team_id: "team-x".to_string(),
    crawl_id: None,
    team_concurrency: Some(12),
    zdr: false,
    url: "https://example.com/doc.pdf".to_string(),
    custom_request_context: false,
    source_kind: SourceKind::Pdf,
    deadline_ms: None,
  }
}

pub fn job_options() -> FirePdfJobOptions {
  FirePdfJobOptions {
    max_pages: None,
    pages_estimate: 0,
    mode: PdfMode::Auto,
    page_markdown: false,
    blocks: false,
    page_markers: false,
    refresh: false,
  }
}

pub fn client_for<'a>(
  io: &'a FakeIo,
  config: &'a FirePdfConfig,
  request: &'a FirePdfRequest,
) -> FirePdfClient<'a, FakeIo> {
  FirePdfClient::new(io, config, request).unwrap()
}
