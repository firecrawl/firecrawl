//! Hand-off to Firecrawl cloud for what a laptop cannot do: web search, pages
//! that block a local fetch, and Alexandria data providers.
//!
//! Nothing here runs unless the caller asks for search or the cloud setting
//! allows a fallback. Every result says it came from the cloud and what it
//! cost, as data fields.

use std::time::Duration;

use serde_json::{json, Value};

pub const DEFAULT_API_URL: &str = "https://api.firecrawl.dev";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloudMode {
  /// Never contact Firecrawl cloud.
  Off,
  /// Search goes to the cloud; scrapes stay local.
  SearchOnly,
  /// Search goes to the cloud, and a scrape the local engine could not
  /// complete is retried there.
  Fallback,
}

impl CloudMode {
  pub fn parse(s: &str) -> Option<CloudMode> {
    match s.to_ascii_lowercase().as_str() {
      "off" | "false" | "0" | "none" => Some(CloudMode::Off),
      "search" | "search-only" => Some(CloudMode::SearchOnly),
      "on" | "auto" | "fallback" | "true" | "1" => Some(CloudMode::Fallback),
      _ => None,
    }
  }
}

#[derive(Clone)]
pub struct Cloud {
  client: reqwest::Client,
  base: String,
  api_key: Option<String>,
  pub mode: CloudMode,
  /// Random ID for this install, so Firecrawl can count installs, not IP
  /// addresses. Created on the first cloud call; never tied to a person.
  install_id: Option<String>,
  /// The agent harness that launched the engine (from the MCP handshake).
  harness: Option<String>,
  origin: String,
}

pub const SIGN_IN_HINT: &str = "Run `firecrawl login`, or set FIRECRAWL_API_KEY.";

fn config_dir() -> Option<std::path::PathBuf> {
  if let Some(dir) = std::env::var_os("FIRECRAWL_LOCAL_HOME") {
    return Some(std::path::PathBuf::from(dir));
  }
  std::env::var_os("HOME").map(|h| {
    std::path::PathBuf::from(h)
      .join(".config")
      .join("firecrawl-local")
  })
}

/// Where the Firecrawl CLI keeps the login from `firecrawl login`. Same
/// paths as the CLI's own `credentials.ts`.
pub fn cli_credentials_path() -> Option<std::path::PathBuf> {
  if let Some(p) = std::env::var_os("FIRECRAWL_CLI_CREDENTIALS") {
    return Some(std::path::PathBuf::from(p));
  }
  let home =
    std::path::PathBuf::from(std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?);
  let dir = if cfg!(target_os = "macos") {
    home
      .join("Library")
      .join("Application Support")
      .join("firecrawl-cli")
  } else if cfg!(target_os = "windows") {
    home.join("AppData").join("Roaming").join("firecrawl-cli")
  } else {
    home.join(".config").join("firecrawl-cli")
  };
  Some(dir.join("credentials.json"))
}

/// The API key and API URL saved by `firecrawl login`, if the user has
/// logged in with the CLI. This is what makes sign-in one step: log in once
/// in the browser and the engine picks it up.
fn cli_credentials() -> (Option<String>, Option<String>) {
  let Some(path) = cli_credentials_path() else {
    return (None, None);
  };
  let Ok(text) = std::fs::read_to_string(path) else {
    return (None, None);
  };
  let Ok(v) = serde_json::from_str::<Value>(&text) else {
    return (None, None);
  };
  let field = |name: &str| {
    v.get(name)
      .and_then(Value::as_str)
      .map(str::trim)
      .filter(|s| !s.is_empty())
      .map(str::to_string)
  };
  (field("apiKey"), field("apiUrl"))
}

/// Read this install's ID, creating it on first use.
fn load_install_id() -> Option<String> {
  let dir = config_dir()?;
  let path = dir.join("install-id");
  if let Ok(existing) = std::fs::read_to_string(&path) {
    let id = existing.trim().to_string();
    if !id.is_empty() {
      return Some(id);
    }
  }
  let id = uuid::Uuid::new_v4().to_string();
  std::fs::create_dir_all(&dir).ok()?;
  std::fs::write(&path, &id).ok()?;
  Some(id)
}

/// How the engine was started, which decides the origin its cloud calls carry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Surface {
  /// A command typed in a terminal, or run by an AI agent through one.
  Cli,
  /// The stdio MCP server.
  Mcp,
  /// The local HTTP API.
  Serve,
}

/// The origin for a surface, in the forms Firecrawl already uses:
/// `cli@<version>` for the CLI and `mcp-<client>@<version>` for an MCP
/// server, where the client is the name the MCP client gave at initialize.
/// The version is marked `local-` so Firecrawl Local can be told apart from the
/// Node CLI and the hosted MCP server.
fn origin_for(surface: Surface, client: Option<&str>) -> String {
  let version = concat!("local-", env!("CARGO_PKG_VERSION"));
  match surface {
    Surface::Cli => format!("cli@{version}"),
    Surface::Serve => format!("firecrawl-local@{version}"),
    Surface::Mcp => {
      let token: String = client
        .unwrap_or("")
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
      let token: String = token
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-")
        .chars()
        .take(48)
        .collect();
      if token.is_empty() {
        format!("mcp-local@{version}")
      } else {
        format!("mcp-{token}@{version}")
      }
    }
  }
}

/// Firecrawl cloud's answer to a forwarded request, passed back untouched.
pub struct Forwarded {
  pub status: u16,
  pub content_type: Option<String>,
  pub body: bytes::Bytes,
}

#[derive(Debug)]
pub struct CloudError {
  pub status: u16,
  pub message: String,
}

impl std::fmt::Display for CloudError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    write!(f, "{}", self.message)
  }
}

impl Cloud {
  /// Reads `FIRECRAWL_API_KEY`, `FIRECRAWL_API_URL` and `FIRECRAWL_CLOUD`,
  /// falling back to the login saved by `firecrawl login`.
  /// With no explicit setting: a key turns the fallback on, no key means
  /// search only.
  pub fn from_env() -> Self {
    let (saved_key, saved_url) = cli_credentials();
    let api_key = std::env::var("FIRECRAWL_API_KEY")
      .ok()
      .filter(|k| !k.trim().is_empty())
      .or(saved_key);
    let base = std::env::var("FIRECRAWL_API_URL")
      .ok()
      .filter(|u| !u.trim().is_empty())
      .or(saved_url)
      .unwrap_or_else(|| DEFAULT_API_URL.to_string());
    let mode = std::env::var("FIRECRAWL_CLOUD")
      .ok()
      .and_then(|m| CloudMode::parse(&m))
      .unwrap_or(CloudMode::Fallback);
    Self::new(base, api_key, mode)
  }

  /// Same as `from_env`, but with the cloud off unless a key or an explicit
  /// `FIRECRAWL_CLOUD` setting turns it on. For `serve`, where the people
  /// calling the API did not install this engine themselves.
  pub fn from_env_opt_in() -> Self {
    let mut cloud = Self::from_env().with_surface(Surface::Serve, None);
    if std::env::var("FIRECRAWL_CLOUD").is_err() && !cloud.has_key() {
      cloud.mode = CloudMode::Off;
    }
    cloud
  }

  /// Use a key obtained mid-session (after a one-step sign-in).
  pub fn with_key(mut self, api_key: String) -> Self {
    self.api_key = Some(api_key);
    self
  }

  /// Tag cloud calls with the harness that launched the engine.
  pub fn with_harness(mut self, harness: Option<String>) -> Self {
    self.harness = harness.map(|h| {
      h.chars()
        .filter(|c| c.is_ascii_graphic() || *c == ' ')
        .take(64)
        .collect()
    });
    self
  }

  pub fn new(base: String, api_key: Option<String>, mode: CloudMode) -> Self {
    let client = reqwest::Client::builder()
      .user_agent(concat!("firecrawl-local/", env!("CARGO_PKG_VERSION")))
      .connect_timeout(Duration::from_secs(10))
      .build()
      .unwrap_or_default();
    Self {
      client,
      base: base.trim_end_matches('/').to_string(),
      api_key,
      mode,
      install_id: None,
      harness: None,
      origin: origin_for(Surface::Cli, None),
    }
  }

  /// Stamp cloud calls with the surface the engine is running as, so the
  /// request is attributed the way the Firecrawl CLI and MCP server are.
  pub fn with_surface(mut self, surface: Surface, client: Option<&str>) -> Self {
    self.origin = origin_for(surface, client);
    self
  }

  pub fn origin(&self) -> &str {
    &self.origin
  }

  pub fn has_key(&self) -> bool {
    self.api_key.is_some()
  }

  /// Use the origin a client stamped on its own request, so a call the
  /// engine passes on is attributed to that client and not to the engine.
  pub fn with_origin(mut self, origin: &str) -> Self {
    let clean: String = origin
      .chars()
      .filter(|c| c.is_ascii_graphic())
      .take(100)
      .collect();
    if !clean.is_empty() {
      self.origin = clean;
    }
    self
  }

  /// Whether a request for `path` may be passed on to Firecrawl cloud.
  pub fn allows(&self, path: &str) -> bool {
    match self.mode {
      CloudMode::Off => false,
      CloudMode::SearchOnly => path == "/v2/search" || path.starts_with("/v2/search/"),
      CloudMode::Fallback => true,
    }
  }

  /// Pass a request this engine does not serve itself on to Firecrawl cloud
  /// and return the answer as it came. The engine's own key is used when it
  /// has one; otherwise the caller's, and with neither the call is keyless.
  pub async fn forward(
    &self,
    method: reqwest::Method,
    path_and_query: &str,
    content_type: Option<&str>,
    body: bytes::Bytes,
    client_auth: Option<&str>,
    client_origin: Option<&str>,
  ) -> Result<Forwarded, CloudError> {
    let origin = match client_origin {
      Some(o) => self.clone().with_origin(o).origin,
      None => self.origin.clone(),
    };
    let mut req = self
      .client
      .request(method, format!("{}{}", self.base, path_and_query))
      .timeout(Duration::from_secs(190))
      .header("x-origin", origin)
      .body(body);
    if let Some(ct) = content_type {
      req = req.header(reqwest::header::CONTENT_TYPE, ct);
    }
    if let Some(id) = self.install_id.clone().or_else(load_install_id) {
      req = req.header("x-firecrawl-install", id);
    }
    if let Some(key) = self.api_key.as_deref().or(client_auth) {
      req = req.bearer_auth(key);
    }
    let resp = req.send().await.map_err(|e| CloudError {
      status: 502,
      message: format!("Could not reach Firecrawl cloud: {e}"),
    })?;
    let status = resp.status().as_u16();
    let content_type = resp
      .headers()
      .get(reqwest::header::CONTENT_TYPE)
      .and_then(|v| v.to_str().ok())
      .map(str::to_string);
    let body = resp.bytes().await.map_err(|e| CloudError {
      status: 502,
      message: format!("Firecrawl cloud's answer was cut short: {e}"),
    })?;
    Ok(Forwarded {
      status,
      content_type,
      body,
    })
  }

  async fn post(
    &self,
    path: &str,
    mut body: Value,
    timeout: Duration,
  ) -> Result<Value, CloudError> {
    // The scrape route reads the origin from the body only, so it travels
    // there as well as in the header.
    if let Some(obj) = body.as_object_mut() {
      obj
        .entry("origin")
        .or_insert_with(|| Value::String(self.origin.clone()));
    }
    let mut req = self
      .client
      .post(format!("{}{}", self.base, path))
      .timeout(timeout)
      .header("x-origin", &self.origin)
      .json(&body);
    if let Some(id) = self.install_id.clone().or_else(load_install_id) {
      req = req.header("x-firecrawl-install", id);
    }
    if let Some(h) = &self.harness {
      req = req.header("x-firecrawl-harness", h);
    }
    if let Some(key) = &self.api_key {
      req = req.bearer_auth(key);
    }
    let resp = req.send().await.map_err(|e| CloudError {
      status: 502,
      message: format!("Could not reach Firecrawl cloud: {e}"),
    })?;
    let status = resp.status().as_u16();
    let payload: Value = resp.json().await.unwrap_or(Value::Null);
    if !(200..300).contains(&status) {
      let detail = payload
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("request failed")
        .to_string();
      let message = match status {
        401 | 402 | 403 | 429 if !self.has_key() => {
          // The cloud sends a signup link made for this caller; pass it on.
          let link = payload
            .get("signupUrl")
            .and_then(Value::as_str)
            .map(|u| format!(" Or sign up at {u}"))
            .unwrap_or_default();
          let reason = detail.lines().next().unwrap_or("").trim();
          format!("Firecrawl cloud needs a sign-in for this ({reason}). {SIGN_IN_HINT}{link}")
        }
        401 if self.has_key() => format!(
          "Firecrawl rejected the saved login ({detail}). It may have been rotated or revoked. Run `firecrawl login` again, or update FIRECRAWL_API_KEY."
        ),
        _ => format!("Firecrawl cloud returned {status}: {detail}"),
      };
      return Err(CloudError { status, message });
    }
    Ok(payload)
  }

  /// Web search. Always a cloud call: there is no index on a laptop.
  pub async fn search(&self, query: &str, limit: u32) -> Result<Value, CloudError> {
    if self.mode == CloudMode::Off {
      return Err(CloudError {
        status: 403,
        message:
          "Web search runs on Firecrawl cloud, and the cloud is turned off (FIRECRAWL_CLOUD=off)."
            .into(),
      });
    }
    let mut payload = self
      .post(
        "/v2/search",
        json!({ "query": query, "limit": limit.clamp(1, 50) }),
        Duration::from_secs(60),
      )
      .await?;
    annotate(&mut payload);
    Ok(payload)
  }

  /// Retry a scrape in the cloud. Only called when the mode is `Fallback`.
  pub async fn scrape(&self, url: &str, options: &Value) -> Result<Value, CloudError> {
    let mut body = options.clone();
    if !body.is_object() {
      body = json!({});
    }
    body["url"] = Value::String(url.to_string());
    let mut payload = self
      .post("/v2/scrape", body, Duration::from_secs(120))
      .await?;
    annotate(&mut payload);
    Ok(payload)
  }
}

impl Cloud {
  /// Run one or more Alexandria provider calls. `calls` is one call object
  /// or an array of up to ten: `{provider, capability, options}`. Needs an
  /// account: providers cost Firecrawl money per call.
  pub async fn alexandria(&self, calls: &Value) -> Result<Value, CloudError> {
    if self.mode == CloudMode::Off {
      return Err(CloudError {
        status: 403,
        message: "Alexandria data providers run on Firecrawl cloud, and the cloud is turned off (FIRECRAWL_CLOUD=off).".into(),
      });
    }
    if !self.has_key() {
      return Err(CloudError {
        status: 401,
        message: format!("Alexandria data providers need a free Firecrawl account. {SIGN_IN_HINT} The same call works after that."),
      });
    }
    let calls = match calls {
      Value::Array(_) => calls.clone(),
      Value::Object(_) => Value::Array(vec![calls.clone()]),
      _ => return Err(CloudError {
        status: 400,
        message:
          "'alexandria' must be a call object or an array of them: {provider, capability, options}."
            .into(),
      }),
    };
    let mut payload = self
      .post(
        "/v2/scrape",
        json!({ "alexandria": calls, "origin": self.origin }),
        Duration::from_secs(190),
      )
      .await?;
    annotate(&mut payload);
    Ok(payload)
  }

  /// Browse or search the Alexandria catalogue. Tried without a key first,
  /// since browsing costs nothing; the cloud decides whether to allow it.
  pub async fn find_tools(&self, options: &Value) -> Result<Value, CloudError> {
    if self.mode == CloudMode::Off {
      return Err(CloudError {
        status: 403,
        message: "The Alexandria catalogue lives on Firecrawl cloud, and the cloud is turned off (FIRECRAWL_CLOUD=off).".into(),
      });
    }
    let call = json!([{ "provider": "firecrawl", "capability": "find-tools", "options": options }]);
    let mut payload = self
      .post(
        "/v2/scrape",
        json!({ "alexandria": call, "origin": self.origin }),
        Duration::from_secs(60),
      )
      .await?;
    annotate(&mut payload);
    Ok(payload)
  }
}

/// Scrape locally; if the page was refused and the cloud fallback is on,
/// retry it through Firecrawl. The result says where it ran.
pub async fn scrape_with_fallback(
  engine: &crate::scrape::Engine,
  cloud: &Cloud,
  url: &str,
  opts: &crate::scrape::ScrapeOptions,
) -> Result<Value, crate::scrape::ScrapeError> {
  let local = engine.scrape(url, opts).await;
  let blocked = match &local {
    Ok(doc) => {
      let status = doc
        .pointer("/metadata/statusCode")
        .and_then(Value::as_u64)
        .unwrap_or(200) as u16;
      let md = doc.get("markdown").and_then(Value::as_str).unwrap_or("");
      looks_blocked(status, md)
    }
    Err(e) => matches!(e.code, "FETCH_FAILED" | "SCRAPE_TIMEOUT"),
  };
  if blocked && cloud.mode == CloudMode::Fallback {
    let cloud_opts = json!({ "formats": ["markdown"], "onlyMainContent": opts.only_main_content });
    if let Ok(payload) = cloud.scrape(url, &cloud_opts).await {
      if let Some(mut data) = payload.get("data").cloned() {
        if let Some(obj) = data.as_object_mut() {
          obj.insert("source".into(), Value::String("firecrawl-cloud".into()));
        }
        return Ok(data);
      }
    }
  }
  match local {
    Ok(mut doc) => {
      if let Some(obj) = doc.as_object_mut() {
        obj.insert("source".into(), Value::String("local".into()));
        if blocked {
          obj.insert("blocked".into(), Value::Bool(true));
        }
      }
      Ok(doc)
    }
    Err(e) => Err(e),
  }
}

/// Mark a cloud response so callers can tell where it ran and what it cost.
fn annotate(payload: &mut Value) {
  if let Some(obj) = payload.as_object_mut() {
    obj.insert("source".into(), Value::String("firecrawl-cloud".into()));
  }
}

/// Signs that a local fetch was refused rather than served.
pub fn looks_blocked(status: u16, markdown: &str) -> bool {
  matches!(status, 401 | 403 | 407 | 429 | 503) || looks_like_bot_check(markdown)
}

/// True when a short page is a bot check or a refusal, not content.
pub fn looks_like_bot_check(markdown: &str) -> bool {
  if markdown.len() > 2000 {
    return false;
  }
  let lower = markdown.to_ascii_lowercase();
  [
    "verify you are human",
    "verifying you are human",
    "checking your browser",
    "verifying your browser",
    "quick browser check",
    "security checkpoint",
    "performing security verification",
    "enable javascript and cookies to continue",
    "attention required! | cloudflare",
    "access denied",
    "are you a robot",
    "captcha",
    "unusual traffic",
    "pardon our interruption",
  ]
  .iter()
  .any(|needle| lower.contains(needle))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn cli_login_is_picked_up() {
    let dir = std::env::temp_dir().join(format!("fc-cred-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("credentials.json");
    std::fs::write(
      &path,
      r#"{"apiKey":"fc-test-key","apiUrl":"https://api.example.test"}"#,
    )
    .unwrap();
    std::env::set_var("FIRECRAWL_CLI_CREDENTIALS", &path);
    let (key, url) = cli_credentials();
    assert_eq!(key.as_deref(), Some("fc-test-key"));
    assert_eq!(url.as_deref(), Some("https://api.example.test"));
    std::fs::write(&path, "not json").unwrap();
    assert_eq!(cli_credentials(), (None, None));
    std::env::remove_var("FIRECRAWL_CLI_CREDENTIALS");
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn origins_follow_the_cli_and_mcp_conventions() {
    let v = concat!("local-", env!("CARGO_PKG_VERSION"));
    assert_eq!(origin_for(Surface::Cli, None), format!("cli@{v}"));
    assert_eq!(
      origin_for(Surface::Serve, None),
      format!("firecrawl-local@{v}")
    );
    assert_eq!(
      origin_for(Surface::Mcp, Some("Claude Code")),
      format!("mcp-claude-code@{v}")
    );
    assert_eq!(
      origin_for(Surface::Mcp, Some("  ")),
      format!("mcp-local@{v}")
    );
    assert_eq!(origin_for(Surface::Mcp, None), format!("mcp-local@{v}"));
    assert!(origin_for(Surface::Mcp, Some("cursor/1.0 (x)")).starts_with("mcp-cursor-1-0-x@"));
  }

  /// A one-request HTTP server that returns what it was sent.
  async fn echo_cloud() -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
      .await
      .unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
      while let Ok((mut socket, _)) = listener.accept().await {
        tokio::spawn(async move {
          let mut buf = vec![0u8; 8192];
          let n = socket.read(&mut buf).await.unwrap_or(0);
          let request = String::from_utf8_lossy(&buf[..n]).to_string();
          let body = serde_json::json!({ "request": request }).to_string();
          let answer = format!(
            "HTTP/1.1 207 Multi-Status\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
            body.len(),
            body
          );
          let _ = socket.write_all(answer.as_bytes()).await;
        });
      }
    });
    base
  }

  #[tokio::test]
  async fn forward_passes_the_request_and_the_answer_through() {
    let base = echo_cloud().await;
    let keyless = Cloud::new(base.clone(), None, CloudMode::Fallback);
    let answer = keyless
      .forward(
        reqwest::Method::POST,
        "/v2/search?x=1",
        Some("application/json"),
        bytes::Bytes::from_static(b"{\"query\":\"q\"}"),
        None,
        Some("mcp-claude-code@3.39.0"),
      )
      .await
      .unwrap();
    assert_eq!(answer.status, 207);
    assert_eq!(answer.content_type.as_deref(), Some("application/json"));
    let seen = String::from_utf8_lossy(&answer.body).to_lowercase();
    assert!(seen.contains("post /v2/search?x=1"), "{seen}");
    assert!(seen.contains("x-origin: mcp-claude-code@3.39.0"), "{seen}");
    assert!(seen.contains("{\\\"query\\\":\\\"q\\\"}"), "{seen}");
    assert!(
      !seen.contains("authorization:"),
      "a keyless call carries no key: {seen}"
    );

    // The caller's key is used when the engine has none, and the engine's wins when it has one.
    let with_client_key = keyless
      .forward(
        reqwest::Method::GET,
        "/v2/team/credit-usage",
        None,
        bytes::Bytes::new(),
        Some("fc-client"),
        None,
      )
      .await
      .unwrap();
    assert!(String::from_utf8_lossy(&with_client_key.body).contains("Bearer fc-client"));
    let own = Cloud::new(base, Some("fc-engine".into()), CloudMode::Fallback);
    let with_own_key = own
      .forward(
        reqwest::Method::GET,
        "/v2/team/credit-usage",
        None,
        bytes::Bytes::new(),
        Some("fc-client"),
        None,
      )
      .await
      .unwrap();
    let seen = String::from_utf8_lossy(&with_own_key.body).to_string();
    assert!(
      seen.contains("Bearer fc-engine") && !seen.contains("fc-client"),
      "{seen}"
    );
  }

  #[test]
  fn modes_decide_what_is_passed_on() {
    let cloud = |mode| Cloud::new("https://api.example.test".into(), None, mode);
    assert!(!cloud(CloudMode::Off).allows("/v2/search"));
    assert!(cloud(CloudMode::SearchOnly).allows("/v2/search"));
    assert!(cloud(CloudMode::SearchOnly).allows("/v2/search/research/papers"));
    assert!(!cloud(CloudMode::SearchOnly).allows("/v2/agent"));
    assert!(!cloud(CloudMode::SearchOnly).allows("/v2/searching"));
    assert!(cloud(CloudMode::Fallback).allows("/v2/agent"));
  }

  #[test]
  fn a_client_origin_replaces_the_engine_origin() {
    let cloud = Cloud::new("https://api.example.test".into(), None, CloudMode::Fallback);
    assert_eq!(
      cloud.clone().with_origin("mcp-claude-code@3.39.0").origin(),
      "mcp-claude-code@3.39.0"
    );
    assert_eq!(cloud.clone().with_origin("  ").origin(), cloud.origin());
    assert_eq!(cloud.with_origin("a b\nc").origin(), "abc");
  }

  #[test]
  fn modes_parse() {
    assert_eq!(CloudMode::parse("off"), Some(CloudMode::Off));
    assert_eq!(CloudMode::parse("search"), Some(CloudMode::SearchOnly));
    assert_eq!(CloudMode::parse("auto"), Some(CloudMode::Fallback));
    assert_eq!(CloudMode::parse("nonsense"), None);
  }

  #[test]
  fn blocked_detection() {
    assert!(looks_blocked(403, "anything"));
    assert!(looks_blocked(
      200,
      "Please verify you are human to continue"
    ));
    assert!(!looks_blocked(
      200,
      "A normal article about captcha history. "
        .repeat(100)
        .as_str()
    ));
    assert!(!looks_blocked(200, "Hello world"));
    assert!(looks_blocked(200, "We're verifying your browser\n\n[Website owner? Click here to fix](https://vercel.link/security-checkpoint)"));
    assert!(looks_blocked(
      200,
      "We're performing a quick browser check to help us fight bots."
    ));
    assert!(looks_like_bot_check("## Performing security verification"));
    assert!(!looks_like_bot_check(
      "A long guide to browser checks. ".repeat(100).as_str()
    ));
  }
}
