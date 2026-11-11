//! `firecrawl-local serve`: the Firecrawl HTTP API on one port.
//!
//! Safety defaults:
//! - binds to loopback unless told otherwise;
//! - a non-loopback bind refuses to start without a token;
//! - every request must carry a Host header naming this machine, which stops
//!   a web page from reaching the API through DNS rebinding;
//! - bodies must be `application/json`, so a browser cannot post to it
//!   cross-origin without a preflight that this server never approves.

use std::{
  collections::HashMap,
  net::SocketAddr,
  sync::{Arc, Mutex},
  time::{Duration, Instant},
};

use axum::{
  body::Bytes,
  extract::{Path, Request, State},
  http::{header, HeaderMap, Method, StatusCode},
  middleware::{self, Next},
  response::{IntoResponse, Response},
  routing::{delete, get, post},
  Json, Router,
};
use serde_json::{json, Value};

use futures::stream::{self, StreamExt};

use crate::{
  cloud::{self, Cloud},
  crawl::{self, CrawlOptions, MapOptions},
  scrape::{Engine, ScrapeError, ScrapeOptions},
};

const JOB_TTL: Duration = Duration::from_secs(60 * 60);

/// The largest body passed on to Firecrawl cloud. Local routes keep axum's
/// 2 MB default; uploads to cloud routes such as /v2/parse need more.
const FORWARD_BODY_LIMIT: usize = 64 * 1024 * 1024;

/// A crawl or batch scrape. Jobs live in memory and expire after an hour.
struct Job {
  status: &'static str,
  total: usize,
  data: Vec<Value>,
  errors: Vec<Value>,
  created: Instant,
  task: Option<tokio::task::AbortHandle>,
}

type Jobs = Mutex<HashMap<String, Arc<Mutex<Job>>>>;

pub struct ServeConfig {
  pub addr: SocketAddr,
  /// Required when `addr` is not loopback.
  pub token: Option<String>,
  /// Extra hostnames accepted in the Host header (for example a compose
  /// service name).
  pub allowed_hosts: Vec<String>,
  /// What may be passed on to Firecrawl cloud. On by default, as it is for
  /// the command line and the MCP launcher; `FIRECRAWL_CLOUD=off` keeps
  /// every request on the machine.
  pub cloud: Cloud,
  /// Whether a caller's own Firecrawl key is used for calls passed on to
  /// Firecrawl cloud when this server has none. True for `serve`, where a
  /// caller may bring a key. False for the MCP launcher: its one caller is
  /// the MCP server it started, whose key is a copy of this process's own
  /// and would otherwise outlive a sign-out.
  pub use_client_key: bool,
}

struct AppState {
  engine: Arc<Engine>,
  cloud: Cloud,
  token: Option<String>,
  use_client_key: bool,
  allowed_hosts: Vec<String>,
  jobs: Jobs,
}

fn error_response(status: StatusCode, code: &str, message: impl Into<String>) -> Response {
  (
    status,
    Json(json!({ "success": false, "code": code, "error": message.into() })),
  )
    .into_response()
}

fn host_without_port(host: &str) -> &str {
  if let Some(rest) = host.strip_prefix('[') {
    return rest.split(']').next().unwrap_or(rest);
  }
  host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host)
}

fn host_allowed(host: &str, extra: &[String]) -> bool {
  let h = host_without_port(host).to_ascii_lowercase();
  h == "localhost"
    || h == "127.0.0.1"
    || h == "::1"
    || extra.iter().any(|e| e.eq_ignore_ascii_case(&h))
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
  if a.len() != b.len() {
    return false;
  }
  a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn gate(State(state): State<Arc<AppState>>, req: Request, next: Next) -> Response {
  let host = req
    .headers()
    .get(header::HOST)
    .and_then(|v| v.to_str().ok())
    .unwrap_or("");
  if !host_allowed(host, &state.allowed_hosts) {
    return error_response(
      StatusCode::FORBIDDEN,
      "HOST_NOT_ALLOWED",
      "Firecrawl Local only answers requests addressed to this machine. Start it with --allowed-host to accept another name.",
    );
  }
  if let Some(expected) = &state.token {
    let presented = req
      .headers()
      .get(header::AUTHORIZATION)
      .and_then(|v| v.to_str().ok())
      .and_then(|v| {
        v.strip_prefix("Bearer ")
          .or_else(|| v.strip_prefix("bearer "))
      })
      .unwrap_or("");
    if !constant_time_eq(presented.as_bytes(), expected.as_bytes()) {
      return error_response(
        StatusCode::UNAUTHORIZED,
        "UNAUTHORIZED",
        "Missing or wrong token. Send 'Authorization: Bearer <token>'.",
      );
    }
  }
  next.run(req).await
}

/// The origin a client put on its request, in the body or the header.
fn client_origin(headers: &HeaderMap, body_origin: Option<&str>) -> Option<String> {
  body_origin
    .filter(|o| !o.is_empty() && *o != "api")
    .map(str::to_string)
    .or_else(|| {
      headers
        .get("x-origin")
        .and_then(|v| v.to_str().ok())
        .filter(|o| !o.is_empty())
        .map(str::to_string)
    })
}

fn is_json(headers: &HeaderMap) -> bool {
  headers
    .get(header::CONTENT_TYPE)
    .and_then(|v| v.to_str().ok())
    .map(|v| v.to_ascii_lowercase().starts_with("application/json"))
    .unwrap_or(false)
}

/// Whether a browser sent this request on behalf of a web page. Browsers
/// put `Origin` on every cross-origin request that can change something and
/// `Sec-Fetch-Site` on all of them; command-line tools and SDKs send neither.
fn from_a_web_page(headers: &HeaderMap) -> bool {
  let value = |name: &str| {
    headers
      .get(name)
      .and_then(|v| v.to_str().ok())
      .map(|v| v.trim().to_ascii_lowercase())
      .filter(|v| !v.is_empty())
  };
  if let Some(site) = value("sec-fetch-site") {
    if site != "same-origin" && site != "none" {
      return true;
    }
  }
  value("origin").is_some()
}

/// Why a request may not be passed on to Firecrawl cloud, if it may not.
///
/// A page open in the user's browser can send "simple" requests (a form
/// post, an upload, a GET) to a loopback port without asking first, and a
/// forwarded request spends the user's Firecrawl key. So a forwarded request
/// must either be `application/json`, which a page cannot send across
/// origins without a preflight this server never grants, or carry none of
/// the headers a browser adds.
fn forward_refusal(
  state: &AppState,
  method: &Method,
  path: &str,
  headers: &HeaderMap,
) -> Option<Response> {
  if cloud::has_dot_segment(path) {
    return Some(error_response(
      StatusCode::BAD_REQUEST,
      "BAD_REQUEST",
      "The path may not contain '.' or '..' segments.",
    ));
  }
  if !state.cloud.allows(path) {
    return Some(
      (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({
          "success": false,
          "code": "CLOUD_ONLY",
          "error": format!(
            "{path} runs on Firecrawl cloud, and FIRECRAWL_CLOUD is set so that it is not passed on. Unset FIRECRAWL_CLOUD, or set it to auto, to pass these requests on."
          ),
          "cloud": { "url": "https://www.firecrawl.dev", "docs": "https://docs.firecrawl.dev" }
        })),
      )
        .into_response(),
    );
  }
  if *method == Method::OPTIONS || (!is_json(headers) && from_a_web_page(headers)) {
    return Some(error_response(
      StatusCode::FORBIDDEN,
      "CROSS_SITE_REQUEST",
      "Firecrawl Local does not pass requests from web pages on to Firecrawl cloud. Call it from a script, an SDK or a command-line tool.",
    ));
  }
  None
}

/// Pass a request on to Firecrawl cloud and hand its answer back, or say
/// plainly why not.
async fn pass_on(
  state: &AppState,
  method: Method,
  path_and_query: &str,
  headers: &HeaderMap,
  body: Bytes,
) -> Response {
  let path = path_and_query.split('?').next().unwrap_or(path_and_query);
  if let Some(refusal) = forward_refusal(state, &method, path, headers) {
    return refusal;
  }
  // With a token set, the caller's bearer is this server's token and must
  // not travel on. Without one it is the caller's own Firecrawl key, unless
  // this server was told not to use callers' keys.
  let client_auth = if state.token.is_none() && state.use_client_key {
    headers
      .get(header::AUTHORIZATION)
      .and_then(|v| v.to_str().ok())
      .and_then(|v| {
        v.strip_prefix("Bearer ")
          .or_else(|| v.strip_prefix("bearer "))
      })
      .filter(|k| !k.is_empty())
  } else {
    None
  };
  let content_type = headers
    .get(header::CONTENT_TYPE)
    .and_then(|v| v.to_str().ok());
  let origin = client_origin(headers, None);
  match state
    .cloud
    .forward(
      method,
      path_and_query,
      content_type,
      body,
      client_auth,
      origin.as_deref(),
    )
    .await
  {
    Ok(answer) => {
      let status = StatusCode::from_u16(answer.status).unwrap_or(StatusCode::BAD_GATEWAY);
      let mut response = (status, answer.body).into_response();
      if let Some(ct) = answer.content_type.and_then(|ct| ct.parse().ok()) {
        response.headers_mut().insert(header::CONTENT_TYPE, ct);
      }
      response
    }
    Err(e) => error_response(
      StatusCode::from_u16(e.status).unwrap_or(StatusCode::BAD_GATEWAY),
      "CLOUD_ERROR",
      e.message,
    ),
  }
}

/// Everything this engine does not serve itself. Routes under /v2 go to
/// Firecrawl cloud: search, data providers, the agent and the rest of the
/// API. Anything else is not an API route.
async fn forward_handler(State(state): State<Arc<AppState>>, req: Request) -> Response {
  let (parts, body) = req.into_parts();
  let (method, uri, headers) = (parts.method, parts.uri, parts.headers);
  if !uri.path().starts_with("/v2/") {
    return error_response(
      StatusCode::NOT_FOUND,
      "NOT_FOUND",
      "Firecrawl Local serves the Firecrawl v2 API. Use /v2/scrape, /v2/map, /v2/crawl or /v2/batch/scrape.",
    );
  }
  // Decide before reading the body, so a refused upload is not buffered.
  if let Some(refusal) = forward_refusal(&state, &method, uri.path(), &headers) {
    return refusal;
  }
  let body = match axum::body::to_bytes(body, FORWARD_BODY_LIMIT).await {
    Ok(body) => body,
    Err(_) => {
      return error_response(
        StatusCode::PAYLOAD_TOO_LARGE,
        "PAYLOAD_TOO_LARGE",
        format!(
          "The request body could not be read, or is larger than the {} MB Firecrawl Local passes on to Firecrawl cloud.",
          FORWARD_BODY_LIMIT / (1024 * 1024)
        ),
      )
    }
  };
  let path_and_query = uri
    .path_and_query()
    .map(|pq| pq.as_str())
    .unwrap_or(uri.path());
  pass_on(&state, method, path_and_query, &headers, body).await
}

fn scrape_error(e: ScrapeError) -> Response {
  let status = StatusCode::from_u16(e.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
  error_response(status, e.code, e.message)
}

/// Parse a JSON body. Anything that is not `application/json` is refused, so
/// a web page cannot post here without a preflight.
fn json_body(headers: &HeaderMap, body: &Bytes) -> Result<Value, Response> {
  if !is_json(headers) {
    return Err(error_response(
      StatusCode::UNSUPPORTED_MEDIA_TYPE,
      "BAD_REQUEST",
      "Send the request body as application/json.",
    ));
  }
  serde_json::from_slice(body).map_err(|e| {
    error_response(
      StatusCode::BAD_REQUEST,
      "BAD_REQUEST",
      format!("Invalid JSON: {e}"),
    )
  })
}

fn required_url(payload: &Value) -> Result<String, Response> {
  match payload.get("url").and_then(Value::as_str) {
    Some(u) if !u.trim().is_empty() => Ok(u.to_string()),
    _ => Err(error_response(
      StatusCode::BAD_REQUEST,
      "BAD_REQUEST",
      "The 'url' field is required.",
    )),
  }
}

fn new_job(state: &AppState, total: usize) -> (String, Arc<Mutex<Job>>) {
  let id = uuid::Uuid::new_v4().to_string();
  let job = Arc::new(Mutex::new(Job {
    status: "scraping",
    total,
    data: Vec::new(),
    errors: Vec::new(),
    created: Instant::now(),
    task: None,
  }));
  let mut jobs = locked(&state.jobs);
  drop_expired(&mut jobs);
  jobs.insert(id.clone(), job.clone());
  (id, job)
}

/// Lock a mutex, taking the data even if another thread panicked while
/// holding it. A job map with one half-updated job is still usable, and a
/// panic here would take every other request down with it.
fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
  mutex
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Remove jobs older than `JOB_TTL`, stopping any that are still running.
/// Runs whenever a job is created or looked up, so an expired job is never
/// served and never keeps working unobserved.
fn drop_expired(jobs: &mut HashMap<String, Arc<Mutex<Job>>>) {
  jobs.retain(|_, job| {
    let mut job = locked(job);
    let live = job.created.elapsed() < JOB_TTL;
    if !live {
      if let Some(task) = job.task.take() {
        task.abort();
      }
    }
    live
  });
}

fn find_job(state: &AppState, id: &str) -> Option<Arc<Mutex<Job>>> {
  let mut jobs = locked(&state.jobs);
  drop_expired(&mut jobs);
  jobs.get(id).cloned()
}

fn job_url(headers: &HeaderMap, path: &str, id: &str) -> String {
  let host = headers
    .get(header::HOST)
    .and_then(|v| v.to_str().ok())
    .unwrap_or("127.0.0.1");
  format!("http://{host}{path}/{id}")
}

async fn map_handler(
  State(state): State<Arc<AppState>>,
  headers: HeaderMap,
  body: Bytes,
) -> Response {
  let payload = match json_body(&headers, &body) {
    Ok(v) => v,
    Err(r) => return r,
  };
  let url = match required_url(&payload) {
    Ok(u) => u,
    Err(r) => return r,
  };
  let opts: MapOptions = match serde_json::from_value(payload) {
    Ok(o) => o,
    Err(e) => {
      return error_response(
        StatusCode::BAD_REQUEST,
        "BAD_REQUEST",
        format!("Invalid options: {e}"),
      )
    }
  };
  match crawl::map(state.engine.clone(), &url, &opts).await {
    Ok(links) => {
      let links = Value::Array(links.into_iter().map(|u| json!({ "url": u })).collect());
      Json(json!({ "success": true, "links": links })).into_response()
    }
    Err(e) => scrape_error(e),
  }
}

async fn crawl_handler(
  State(state): State<Arc<AppState>>,
  req_uri: axum::http::Uri,
  headers: HeaderMap,
  body: Bytes,
) -> Response {
  let payload = match json_body(&headers, &body) {
    Ok(v) => v,
    Err(r) => return r,
  };
  let url = match required_url(&payload) {
    Ok(u) => u,
    Err(r) => return r,
  };
  let mut payload = payload;
  // v1 named the depth option maxDepth.
  if let Some(depth) = payload.get("maxDepth").cloned() {
    if payload.get("maxDiscoveryDepth").is_none() {
      payload["maxDiscoveryDepth"] = depth;
    }
  }
  let opts: CrawlOptions = match serde_json::from_value(payload) {
    Ok(o) => o,
    Err(e) => {
      return error_response(
        StatusCode::BAD_REQUEST,
        "BAD_REQUEST",
        format!("Invalid options: {e}"),
      )
    }
  };
  let (id, job) = new_job(&state, 0);
  let engine = state.engine.clone();
  let task_job = job.clone();
  let handle = tokio::spawn(async move {
    let sink = task_job.clone();
    let result = crawl::crawl(engine, &url, &opts, move |page| {
      if let Ok(mut j) = sink.lock() {
        j.data.push(page.clone());
        j.total = j.data.len();
      }
    })
    .await;
    if let Ok(mut j) = task_job.lock() {
      match result {
        Ok(outcome) => {
          j.errors = outcome.errors;
          j.total = j.data.len();
          j.status = "completed";
        }
        Err(e) => {
          j.errors.push(json!({ "error": e.message, "code": e.code }));
          j.status = "failed";
        }
      }
    }
  });
  locked(&job).task = Some(handle.abort_handle());
  let base = req_uri.path().trim_end_matches('/').to_string();
  Json(json!({ "success": true, "id": id, "url": job_url(&headers, &base, &id) })).into_response()
}

async fn batch_handler(
  State(state): State<Arc<AppState>>,
  req_uri: axum::http::Uri,
  headers: HeaderMap,
  body: Bytes,
) -> Response {
  let payload = match json_body(&headers, &body) {
    Ok(v) => v,
    Err(r) => return r,
  };
  let urls: Vec<String> = payload
    .get("urls")
    .and_then(Value::as_array)
    .map(|a| {
      a.iter()
        .filter_map(|v| v.as_str().map(str::to_string))
        .collect()
    })
    .unwrap_or_default();
  if urls.is_empty() {
    return error_response(
      StatusCode::BAD_REQUEST,
      "BAD_REQUEST",
      "The 'urls' field needs at least one URL.",
    );
  }
  let concurrency = payload
    .get("maxConcurrency")
    .and_then(Value::as_u64)
    .map(|n| n as usize)
    .unwrap_or(16)
    .clamp(1, 128);
  let opts: ScrapeOptions = match serde_json::from_value(payload) {
    Ok(o) => o,
    Err(e) => {
      return error_response(
        StatusCode::BAD_REQUEST,
        "BAD_REQUEST",
        format!("Invalid options: {e}"),
      )
    }
  };
  let (id, job) = new_job(&state, urls.len());
  let engine = state.engine.clone();
  let task_job = job.clone();
  let handle = tokio::spawn(async move {
    let mut results = stream::iter(urls.into_iter().map(|url| {
      let engine = engine.clone();
      let opts = opts.clone();
      async move {
        let res = engine.scrape(&url, &opts).await;
        (url, res)
      }
    }))
    .buffer_unordered(concurrency);
    while let Some((url, res)) = results.next().await {
      if let Ok(mut j) = task_job.lock() {
        match res {
          Ok(doc) => j.data.push(doc),
          Err(e) => j
            .errors
            .push(json!({ "url": url, "error": e.message, "code": e.code })),
        }
      }
    }
    if let Ok(mut j) = task_job.lock() {
      j.status = "completed";
    }
  });
  locked(&job).task = Some(handle.abort_handle());
  let base = req_uri.path().trim_end_matches('/').to_string();
  Json(json!({ "success": true, "id": id, "url": job_url(&headers, &base, &id) })).into_response()
}

async fn job_status(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
  let job = find_job(&state, &id);
  let Some(job) = job else {
    return error_response(StatusCode::NOT_FOUND, "JOB_NOT_FOUND", "Job not found.");
  };
  let j = locked(&job);
  let expires = (JOB_TTL.saturating_sub(j.created.elapsed())).as_secs();
  Json(json!({
    "success": true,
    "status": j.status,
    "total": j.total.max(j.data.len()),
    "completed": j.data.len(),
    "creditsUsed": 0,
    "expiresInSeconds": expires,
    "errors": j.errors,
    "data": j.data,
  }))
  .into_response()
}

async fn job_cancel(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
  let job = find_job(&state, &id);
  let Some(job) = job else {
    return error_response(StatusCode::NOT_FOUND, "JOB_NOT_FOUND", "Job not found.");
  };
  let mut j = locked(&job);
  if j.status == "scraping" {
    if let Some(task) = j.task.take() {
      task.abort();
    }
    j.status = "cancelled";
  }
  Json(json!({ "success": true, "status": "cancelled" })).into_response()
}

async fn scrape_handler(
  State(state): State<Arc<AppState>>,
  headers: HeaderMap,
  body: Bytes,
) -> Response {
  let payload = match json_body(&headers, &body) {
    Ok(v) => v,
    Err(r) => return r,
  };
  // An Alexandria provider call. This engine has no data providers of its
  // own, so the request goes to Firecrawl cloud as it came.
  if payload.get("alexandria").is_some() {
    return pass_on(&state, Method::POST, "/v2/scrape", &headers, body).await;
  }
  let url = match required_url(&payload) {
    Ok(u) => u,
    Err(r) => return r,
  };
  let origin = payload
    .get("origin")
    .and_then(Value::as_str)
    .map(str::to_string);
  let opts: ScrapeOptions = match serde_json::from_value(payload) {
    Ok(o) => o,
    Err(e) => {
      return error_response(
        StatusCode::BAD_REQUEST,
        "BAD_REQUEST",
        format!("Invalid options: {e}"),
      )
    }
  };
  // A page this machine cannot load is fetched by Firecrawl cloud under the
  // origin the client gave, so the call is counted as that client's.
  let cloud = match client_origin(&headers, origin.as_deref()) {
    Some(origin) => state.cloud.clone().with_origin(&origin),
    None => state.cloud.clone(),
  };
  match cloud::scrape_with_fallback(&state.engine, &cloud, &url, &opts).await {
    Ok(data) => Json(json!({ "success": true, "data": data })).into_response(),
    Err(e) => scrape_error(e),
  }
}

async fn health() -> impl IntoResponse {
  Json(json!({ "status": "ok", "engine": "firecrawl-local", "version": env!("CARGO_PKG_VERSION") }))
}

/// Resolves on Ctrl-C or, on Unix, SIGTERM, so the caller can stop the
/// browser before the process exits.
async fn shutdown_signal() {
  #[cfg(unix)]
  {
    use tokio::signal::unix::{signal, SignalKind};
    match signal(SignalKind::terminate()) {
      Ok(mut term) => {
        tokio::select! {
          _ = tokio::signal::ctrl_c() => {}
          _ = term.recv() => {}
        }
      }
      Err(_) => {
        let _ = tokio::signal::ctrl_c().await;
      }
    }
  }
  #[cfg(not(unix))]
  {
    let _ = tokio::signal::ctrl_c().await;
  }
}

pub async fn serve(engine: Arc<Engine>, cfg: ServeConfig) -> Result<(), String> {
  if !cfg.addr.ip().is_loopback() && cfg.token.is_none() {
    return Err(format!(
      "Refusing to listen on {} without a token. Anyone who can reach that address could use it. \
       Pass --token <secret> (or FIRECRAWL_LOCAL_TOKEN), or bind to 127.0.0.1.",
      cfg.addr
    ));
  }
  let listener = tokio::net::TcpListener::bind(cfg.addr)
    .await
    .map_err(|e| format!("could not listen on {}: {e}", cfg.addr))?;
  eprintln!("firecrawl-local listening on http://{}", cfg.addr);
  eprintln!("{}", cloud_notice(&cfg.cloud));
  serve_on(listener, engine, cfg, shutdown_signal()).await
}

/// One line at startup saying what leaves the machine.
fn cloud_notice(cloud: &Cloud) -> &'static str {
  match cloud.mode {
    cloud::CloudMode::Off => "Firecrawl cloud is off (FIRECRAWL_CLOUD). Every request stays on this machine.",
    cloud::CloudMode::SearchOnly => "Search is passed on to Firecrawl cloud. Everything else stays on this machine.",
    cloud::CloudMode::Fallback => "Scrape, crawl and map run here. Search, data providers and pages this machine cannot load go to Firecrawl cloud. FIRECRAWL_CLOUD=off keeps everything local.",
  }
}

/// Serve the API on a listener the caller already bound, until `stop`
/// resolves. The MCP launcher uses this with a port the system picked.
pub async fn serve_on(
  listener: tokio::net::TcpListener,
  engine: Arc<Engine>,
  cfg: ServeConfig,
  stop: impl std::future::Future<Output = ()> + Send + 'static,
) -> Result<(), String> {
  let mut allowed_hosts = cfg.allowed_hosts.clone();
  if !cfg.addr.ip().is_unspecified() {
    allowed_hosts.push(cfg.addr.ip().to_string());
  }

  let state = Arc::new(AppState {
    engine,
    cloud: cfg.cloud,
    token: cfg.token,
    use_client_key: cfg.use_client_key,
    allowed_hosts,
    jobs: Mutex::new(HashMap::new()),
  });

  let app = Router::new()
    .route("/v2/scrape", post(scrape_handler))
    .route("/v2/map", post(map_handler))
    .route("/v2/crawl", post(crawl_handler))
    .route("/v2/crawl/{id}", get(job_status))
    .route("/v2/crawl/{id}", delete(job_cancel))
    .route("/v2/batch/scrape", post(batch_handler))
    .route("/v2/batch/scrape/{id}", get(job_status))
    .route("/v2/batch/scrape/{id}", delete(job_cancel))
    .route("/health", get(health))
    .fallback(forward_handler)
    .layer(middleware::from_fn_with_state(state.clone(), gate))
    .with_state(state);

  axum::serve(listener, app)
    .with_graceful_shutdown(stop)
    .await
    .map_err(|e| format!("server error: {e}"))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn host_checks() {
    assert!(host_allowed("localhost:3002", &[]));
    assert!(host_allowed("127.0.0.1:3002", &[]));
    assert!(host_allowed("[::1]:3002", &[]));
    assert!(!host_allowed("evil.example:3002", &[]));
    assert!(!host_allowed("", &[]));
    assert!(host_allowed("engine:3002", &["engine".to_string()]));
  }

  fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
    let mut map = HeaderMap::new();
    for (name, value) in pairs {
      map.insert(
        axum::http::HeaderName::from_bytes(name.as_bytes()).unwrap(),
        value.parse().unwrap(),
      );
    }
    map
  }

  #[test]
  fn browser_requests_are_told_apart_from_tools() {
    assert!(!from_a_web_page(&headers(&[])));
    assert!(!from_a_web_page(&headers(&[("user-agent", "curl/8")])));
    assert!(from_a_web_page(&headers(&[(
      "origin",
      "https://evil.example"
    )])));
    assert!(from_a_web_page(&headers(&[("origin", "null")])));
    assert!(from_a_web_page(&headers(&[(
      "sec-fetch-site",
      "cross-site"
    )])));
    assert!(from_a_web_page(&headers(&[(
      "sec-fetch-site",
      "same-site"
    )])));
    assert!(!from_a_web_page(&headers(&[("sec-fetch-site", "none")])));
  }

  /// Start the server against a stand-in cloud and return its address.
  async fn start(mode: cloud::CloudMode) -> String {
    start_with(mode, Some("fc-own"), true).await
  }

  async fn start_with(
    mode: cloud::CloudMode,
    own_key: Option<&str>,
    use_client_key: bool,
  ) -> String {
    let engine = Arc::new(
      Engine::new(crate::scrape::EngineConfig {
        policy: crate::guard::NetworkPolicy::PublicOnly,
        user_agent: None,
        browser: crate::scrape::BrowserMode::Never,
      })
      .unwrap(),
    );
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
      .await
      .unwrap();
    let addr = listener.local_addr().unwrap();
    let cfg = ServeConfig {
      addr,
      token: None,
      allowed_hosts: Vec::new(),
      cloud: Cloud::new(cloud::echo_cloud().await, own_key.map(str::to_string), mode)
        .with_install_id("test-install"),
      use_client_key,
    };
    tokio::spawn(serve_on(listener, engine, cfg, std::future::pending()));
    format!("http://{addr}")
  }

  #[tokio::test]
  async fn a_callers_key_is_used_only_where_callers_bring_their_own() {
    let http = reqwest::Client::new();
    let search = |base: String| {
      http
        .post(format!("{base}/v2/search"))
        .header("content-type", "application/json")
        .header("authorization", "Bearer fc-callers-key")
        .body("{}")
        .send()
    };
    // `serve` with no key of its own passes the caller's key on.
    let open = start_with(cloud::CloudMode::Fallback, None, true).await;
    let seen = search(open).await.unwrap().text().await.unwrap();
    assert!(seen.contains("Bearer fc-callers-key"), "{seen}");
    // The MCP launcher's server does not: once this process is signed out,
    // the copy of the key its MCP server still holds must stop working.
    let launcher = start_with(cloud::CloudMode::Fallback, None, false).await;
    let seen = search(launcher)
      .await
      .unwrap()
      .text()
      .await
      .unwrap()
      .to_lowercase();
    assert!(
      !seen.contains("fc-callers-key") && !seen.contains("authorization:"),
      "{seen}"
    );
  }

  #[tokio::test]
  async fn a_web_page_cannot_spend_the_key_through_a_forwarded_route() {
    let base = start(cloud::CloudMode::Fallback).await;
    let http = reqwest::Client::new();

    // A form post or an upload from a page: no preflight, so it must be refused here.
    for content_type in [
      "text/plain",
      "multipart/form-data; boundary=x",
      "application/x-www-form-urlencoded",
    ] {
      let answer = http
        .post(format!("{base}/v2/search"))
        .header("origin", "https://evil.example")
        .header("content-type", content_type)
        .body("{\"query\":\"q\"}")
        .send()
        .await
        .unwrap();
      assert_eq!(answer.status().as_u16(), 403, "{content_type}");
    }
    let image_tag = http
      .get(format!("{base}/v2/team/credit-usage"))
      .header("sec-fetch-site", "cross-site")
      .send()
      .await
      .unwrap();
    assert_eq!(image_tag.status().as_u16(), 403);
    let preflight = http
      .request(reqwest::Method::OPTIONS, format!("{base}/v2/search"))
      .header("origin", "https://evil.example")
      .send()
      .await
      .unwrap();
    assert_eq!(preflight.status().as_u16(), 403);

    // The same upload from a tool goes through, and so does JSON.
    let upload = http
      .post(format!("{base}/v2/parse"))
      .header("content-type", "multipart/form-data; boundary=x")
      .body("--x--")
      .send()
      .await
      .unwrap();
    assert_eq!(upload.status().as_u16(), 207);
    let json = http
      .post(format!("{base}/v2/search"))
      .header("content-type", "application/json")
      .body("{\"query\":\"q\"}")
      .send()
      .await
      .unwrap();
    assert_eq!(json.status().as_u16(), 207);
    assert!(json.text().await.unwrap().contains("Bearer fc-own"));
  }

  #[tokio::test]
  async fn search_only_mode_cannot_be_walked_out_of() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let base = start(cloud::CloudMode::SearchOnly).await;
    // Sent raw: an HTTP client would tidy the path before it left.
    for path in ["/v2/search/../agent", "/v2/search/%2e%2e/agent"] {
      let mut socket = tokio::net::TcpStream::connect(base.trim_start_matches("http://"))
        .await
        .unwrap();
      let request = format!(
        "POST {path} HTTP/1.1\r\nhost: {}\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{{}}",
        base.trim_start_matches("http://")
      );
      socket.write_all(request.as_bytes()).await.unwrap();
      let mut answer = String::new();
      socket.read_to_string(&mut answer).await.unwrap();
      assert!(answer.starts_with("HTTP/1.1 400"), "{path}: {answer}");
    }
    let http = reqwest::Client::new();
    let agent = http
      .post(format!("{base}/v2/agent"))
      .header("content-type", "application/json")
      .body("{}")
      .send()
      .await
      .unwrap();
    assert_eq!(agent.status().as_u16(), 501);
    let search = http
      .post(format!("{base}/v2/search"))
      .header("content-type", "application/json")
      .body("{}")
      .send()
      .await
      .unwrap();
    assert_eq!(search.status().as_u16(), 207);
  }

  #[tokio::test]
  async fn a_forwarded_upload_may_be_larger_than_two_megabytes() {
    let base = start(cloud::CloudMode::Fallback).await;
    let answer = reqwest::Client::new()
      .post(format!("{base}/v2/parse"))
      .header("content-type", "application/octet-stream")
      .body(vec![b'a'; 3 * 1024 * 1024])
      .send()
      .await
      .unwrap();
    assert_eq!(answer.status().as_u16(), 207);
  }

  #[test]
  fn token_compare() {
    assert!(constant_time_eq(b"abc", b"abc"));
    assert!(!constant_time_eq(b"abc", b"abd"));
    assert!(!constant_time_eq(b"abc", b"ab"));
  }
}
