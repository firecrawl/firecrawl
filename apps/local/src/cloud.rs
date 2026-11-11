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
    match s.trim().to_ascii_lowercase().as_str() {
      "off" | "false" | "0" | "none" | "no" | "disabled" | "disable" => Some(CloudMode::Off),
      "search" | "search-only" => Some(CloudMode::SearchOnly),
      "on" | "auto" | "fallback" | "true" | "1" | "yes" | "enabled" | "enable" => {
        Some(CloudMode::Fallback)
      }
      _ => None,
    }
  }

  /// The mode a `FIRECRAWL_CLOUD` value asks for. Unset or empty asks for
  /// nothing. A value that is not understood asks for off: someone who set
  /// it was restricting the cloud, and a typo must not open it up.
  pub fn requested(raw: Option<&str>) -> Option<CloudMode> {
    let raw = raw.map(str::trim).filter(|r| !r.is_empty())?;
    Some(CloudMode::parse(raw).unwrap_or(CloudMode::Off))
  }
}

/// Whether a path has a `.` or `..` segment, plain or percent-encoded. The
/// HTTP client resolves those before sending, so `/v2/search/../agent` would
/// arrive as `/v2/agent`. Such paths are never passed on.
pub fn has_dot_segment(path: &str) -> bool {
  path.split(['/', '\\']).any(|segment| {
    let segment = segment.to_ascii_lowercase().replace("%2e", ".");
    segment == "." || segment == ".."
  })
}

/// Say once that `FIRECRAWL_CLOUD` holds a value this build does not know.
fn warn_unknown_mode(raw: &str) {
  static ONCE: std::sync::Once = std::sync::Once::new();
  ONCE.call_once(|| {
    eprintln!(
      "FIRECRAWL_CLOUD={raw} is not a setting Firecrawl Local knows (off, search or auto). The cloud stays off."
    );
  });
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
  /// Whether to use the login saved by `firecrawl-local login` or the
  /// Firecrawl CLI. It is read again on every call, so signing in while an
  /// MCP server or `serve` is running takes effect without a restart.
  saved_login: bool,
}

pub const SIGN_IN_HINT: &str = "Run `firecrawl-local login`, or set FIRECRAWL_API_KEY.";

/// Reword a refusal Firecrawl cloud sent to a caller with no key, so it says
/// what to do on this machine. The cloud writes these for people calling the
/// API directly ("authenticate with: Authorization: Bearer ..."); someone
/// using a local MCP server or `serve` signs in with one command instead.
pub fn local_sign_in_message(error: &str) -> String {
  let lower = error.to_ascii_lowercase();
  let mut text = match lower.find("then authenticate with") {
    Some(at) => error[..at].trim_end().to_string(),
    None => error.trim().to_string(),
  };
  if lower.contains("alexandria") && lower.contains("api key") {
    text = "Alexandria data providers need a free Firecrawl account.".to_string();
  }
  if text.contains("firecrawl-local login") {
    return text;
  }
  if text.contains("http") {
    // Keep the sign-up link on its own line so nothing is glued to it.
    format!(
      "{text}\n\nOr run `firecrawl-local login`, which signs you in and saves the key for you."
    )
  } else {
    format!("{text} Run `firecrawl-local login` to create one or sign in. It is one step in the browser and the key is saved for you, then the same call works.")
  }
}

/// Whether a refusal is about the caller having no account, as opposed to a
/// route's own rule or an ordinary rate limit that signing in would not lift.
fn is_sign_in_refusal(status: u16, payload: &Value, error: &str) -> bool {
  if status == 401 || payload.get("signup_url").is_some() || payload.get("signupUrl").is_some() {
    return true;
  }
  let lower = error.to_ascii_lowercase();
  ["keyless", "api key", "unauthorized", "authenticate with"]
    .iter()
    .any(|sign| lower.contains(sign))
}

/// Apply `local_sign_in_message` to the `error` field of a JSON answer, when
/// the answer is a refusal for want of an account.
fn with_sign_in_step(status: u16, body: &[u8]) -> Option<bytes::Bytes> {
  let mut payload: Value = serde_json::from_slice(body).ok()?;
  let error = payload.get("error")?.as_str()?.to_string();
  if !is_sign_in_refusal(status, &payload, &error) {
    return None;
  }
  payload["error"] = Value::String(local_sign_in_message(&error));
  serde_json::to_vec(&payload).ok().map(bytes::Bytes::from)
}

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
  /// falling back to the login saved by `firecrawl-local login` or the
  /// Firecrawl CLI. With no key, cloud calls go out keyless and Firecrawl
  /// cloud decides what a caller without an account may do.
  pub fn from_env() -> Self {
    let (_, saved_url) = cli_credentials();
    let api_key = std::env::var("FIRECRAWL_API_KEY")
      .ok()
      .filter(|k| !k.trim().is_empty());
    let base = std::env::var("FIRECRAWL_API_URL")
      .ok()
      .filter(|u| !u.trim().is_empty())
      .or(saved_url)
      .unwrap_or_else(|| DEFAULT_API_URL.to_string());
    let setting = std::env::var("FIRECRAWL_CLOUD").ok();
    if let Some(raw) = setting.as_deref().map(str::trim) {
      if !raw.is_empty() && CloudMode::parse(raw).is_none() {
        warn_unknown_mode(raw);
      }
    }
    let mode = CloudMode::requested(setting.as_deref()).unwrap_or(CloudMode::Fallback);
    let mut cloud = Self::new(base, api_key, mode);
    cloud.saved_login = true;
    cloud
  }

  /// The key cloud calls go out with: the one given explicitly, or else the
  /// saved login as it is on disk right now.
  fn key(&self) -> Option<String> {
    self.api_key.clone().or_else(|| {
      if self.saved_login {
        cli_credentials().0
      } else {
        None
      }
    })
  }

  /// Give the cloud a fixed install ID, so a test never writes one to the
  /// developer's config folder.
  #[cfg(test)]
  pub(crate) fn with_install_id(mut self, id: &str) -> Self {
    self.install_id = Some(id.to_string());
    self
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
      saved_login: false,
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
    self.key().is_some()
  }

  /// The key in use right now, for handing to the MCP server this process
  /// starts. Never printed.
  pub fn api_key(&self) -> Option<String> {
    self.key()
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
    if has_dot_segment(path) {
      return false;
    }
    match self.mode {
      CloudMode::Off => false,
      CloudMode::SearchOnly => path == "/v2/search" || path.starts_with("/v2/search/"),
      CloudMode::Fallback => true,
    }
  }

  /// Pass a request Firecrawl Local does not serve itself on to Firecrawl
  /// cloud and return the answer. Its own key is used when it has one;
  /// otherwise the caller's, and with neither the call is keyless. A keyless
  /// call that the cloud refuses comes back with the sign-in step added.
  pub async fn forward(
    &self,
    method: reqwest::Method,
    path_and_query: &str,
    content_type: Option<&str>,
    body: bytes::Bytes,
    client_auth: Option<&str>,
    client_origin: Option<&str>,
  ) -> Result<Forwarded, CloudError> {
    let path = path_and_query.split('?').next().unwrap_or(path_and_query);
    if !self.allows(path) {
      return Err(CloudError {
        status: 400,
        message: format!("{path} is not a path Firecrawl Local passes on to Firecrawl cloud."),
      });
    }
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
    let own_key = self.key();
    let key = own_key.as_deref().or(client_auth);
    let keyless = key.is_none();
    if let Some(key) = key {
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
    let mut body = resp.bytes().await.map_err(|e| CloudError {
      status: 502,
      message: format!("Firecrawl cloud's answer was cut short: {e}"),
    })?;
    if keyless && matches!(status, 401 | 402 | 403 | 429) {
      if let Some(reworded) = with_sign_in_step(status, &body) {
        body = reworded;
      }
    }
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
    let key = self.key();
    let signed_in = key.is_some();
    if let Some(key) = &key {
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
        401 | 402 | 403 | 429 if !signed_in => {
          // The cloud sends a signup link made for this caller; pass it on.
          let link = payload
            .get("signupUrl")
            .and_then(Value::as_str)
            .map(|u| format!(" Or sign up at {u}"))
            .unwrap_or_default();
          let reason = detail.lines().next().unwrap_or("").trim();
          format!("Firecrawl cloud needs a sign-in for this ({reason}). {SIGN_IN_HINT}{link}")
        }
        401 if signed_in => format!(
          "Firecrawl rejected the saved login ({detail}). It may have been rotated or revoked. Run `firecrawl-local login` again, or update FIRECRAWL_API_KEY."
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
  let mut status = 0u16;
  let blocked = match &local {
    Ok(doc) => {
      status = doc
        .pointer("/metadata/statusCode")
        .and_then(Value::as_u64)
        .unwrap_or(200) as u16;
      let md = doc.get("markdown").and_then(Value::as_str).unwrap_or("");
      looks_blocked(status, md)
    }
    Err(e) => matches!(e.code, "FETCH_FAILED" | "SCRAPE_TIMEOUT"),
  };
  // Why the cloud did not take over, when it was asked and could not.
  let mut cloud_refusal: Option<String> = None;
  if blocked && cloud.mode == CloudMode::Fallback {
    let cloud_opts = json!({ "formats": ["markdown"], "onlyMainContent": opts.only_main_content });
    match cloud.scrape(url, &cloud_opts).await {
      Ok(payload) => {
        if let Some(mut data) = payload.get("data").cloned() {
          if let Some(obj) = data.as_object_mut() {
            obj.insert("source".into(), Value::String("firecrawl-cloud".into()));
          }
          return Ok(data);
        }
      }
      Err(e) => cloud_refusal = Some(e.message),
    }
  }
  match local {
    Ok(mut doc) => {
      if let Some(obj) = doc.as_object_mut() {
        obj.insert("source".into(), Value::String("local".into()));
        if blocked {
          obj.insert("blocked".into(), Value::Bool(true));
          crate::scrape::add_warning(
            obj,
            blocked_warning(status, cloud.mode, cloud_refusal.as_deref()),
          );
        }
      }
      Ok(doc)
    }
    Err(e) => Err(e),
  }
}

/// What to tell someone whose page came back refused, so an empty result is
/// never mistaken for an empty page.
fn blocked_warning(status: u16, mode: CloudMode, cloud_refusal: Option<&str>) -> String {
  let lead = format!(
    "This site did not serve the page to this machine (status {status}), so the content is missing or is a bot check."
  );
  match (cloud_refusal, mode) {
    (Some(refusal), _) => format!("{lead} Firecrawl cloud did not fetch it either. {refusal}"),
    (None, CloudMode::Fallback) => lead,
    (None, _) => {
      format!("{lead} Firecrawl cloud can fetch pages like this when FIRECRAWL_CLOUD is auto.")
    }
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

/// A stand-in for Firecrawl cloud that returns what it was sent.
#[cfg(test)]
pub(crate) async fn echo_cloud() -> String {
  use tokio::io::{AsyncReadExt, AsyncWriteExt};
  let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
    .await
    .unwrap();
  let base = format!("http://{}", listener.local_addr().unwrap());
  tokio::spawn(async move {
    while let Ok((mut socket, _)) = listener.accept().await {
      tokio::spawn(async move {
        // Read the whole request, keeping only its first 8 KB to echo.
        let mut seen: Vec<u8> = Vec::new();
        let mut buf = vec![0u8; 64 * 1024];
        let mut wanted: Option<usize> = None;
        let mut total = 0usize;
        loop {
          let n = socket.read(&mut buf).await.unwrap_or(0);
          if n == 0 {
            break;
          }
          total += n;
          if seen.len() < 8192 {
            let room = 8192 - seen.len();
            seen.extend_from_slice(&buf[..n.min(room)]);
          }
          if wanted.is_none() {
            let text = String::from_utf8_lossy(&seen).to_lowercase();
            if let Some(head_end) = text.find("\r\n\r\n") {
              let length = text[..head_end]
                .lines()
                .find_map(|l| l.strip_prefix("content-length:"))
                .and_then(|v| v.trim().parse::<usize>().ok())
                .unwrap_or(0);
              wanted = Some(head_end + 4 + length);
            }
          }
          if wanted.is_some_and(|w| total >= w) {
            break;
          }
        }
        let request = String::from_utf8_lossy(&seen).to_string();
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

/// A stand-in for Firecrawl cloud that refuses every call the way the
/// keyless limit does.
#[cfg(test)]
pub(crate) async fn refusing_cloud() -> String {
  use tokio::io::{AsyncReadExt, AsyncWriteExt};
  let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
    .await
    .unwrap();
  let base = format!("http://{}", listener.local_addr().unwrap());
  tokio::spawn(async move {
    while let Ok((mut socket, _)) = listener.accept().await {
      tokio::spawn(async move {
        let mut buf = vec![0u8; 8192];
        let _ = socket.read(&mut buf).await;
        let body = serde_json::json!({
          "success": false,
          "error": "You've hit Firecrawl's keyless free tier rate limit. To continue now, create a free API key at https://firecrawl.dev/k/abc123\n\nThen authenticate with:\nAuthorization: Bearer YOUR_API_KEY",
          "signup_url": "https://firecrawl.dev/k/abc123"
        })
        .to_string();
        let answer = format!(
          "HTTP/1.1 429 Too Many Requests\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
          body.len(),
          body
        );
        let _ = socket.write_all(answer.as_bytes()).await;
      });
    }
  });
  base
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

    // A login made while the process is running is picked up on the next call.
    let mut running = Cloud::new("https://api.example.test".into(), None, CloudMode::Fallback);
    running.saved_login = true;
    assert!(!running.has_key());
    std::fs::write(&path, r#"{"apiKey":"fc-signed-in-later"}"#).unwrap();
    assert_eq!(running.key().as_deref(), Some("fc-signed-in-later"));
    // A key given explicitly wins, and a cloud that was not told to use the
    // saved login never reads it.
    assert_eq!(
      running
        .clone()
        .with_key("fc-explicit".into())
        .key()
        .as_deref(),
      Some("fc-explicit")
    );
    let plain = Cloud::new("https://api.example.test".into(), None, CloudMode::Fallback);
    assert!(!plain.has_key());
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

  #[tokio::test]
  async fn forward_passes_the_request_and_the_answer_through() {
    let base = echo_cloud().await;
    let keyless =
      Cloud::new(base.clone(), None, CloudMode::Fallback).with_install_id("test-install");
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
    let own = Cloud::new(base, Some("fc-engine".into()), CloudMode::Fallback)
      .with_install_id("test-install");
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
  fn refusals_are_reworded_for_a_local_user() {
    let limit = "You've hit Firecrawl's keyless free tier rate limit. To continue now, create a free API key at https://firecrawl.dev/k/abc123\n\nThen authenticate with:\nAuthorization: Bearer YOUR_API_KEY";
    let said = local_sign_in_message(limit);
    assert!(said.contains("https://firecrawl.dev/k/abc123\n"), "{said}");
    assert!(said.contains("firecrawl-local login"), "{said}");
    assert!(!said.contains("Authorization"), "{said}");

    let alexandria =
      local_sign_in_message("Alexandria requires an API key on a team with Alexandria access");
    assert!(alexandria.starts_with("Alexandria data providers need a free Firecrawl account."));
    assert!(alexandria.contains("firecrawl-local login"), "{alexandria}");

    // Said once, not twice.
    assert_eq!(local_sign_in_message(&said), said);

    let body = with_sign_in_step(
      429,
      br#"{"success":false,"error":"Daily limit reached","signup_url":"x"}"#,
    )
    .unwrap();
    let payload: Value = serde_json::from_slice(&body).unwrap();
    assert!(payload["error"]
      .as_str()
      .unwrap()
      .contains("firecrawl-local login"));
    assert_eq!(payload["signup_url"], "x");
    assert!(with_sign_in_step(401, br#"{"error":"Unauthorized"}"#).is_some());
    assert!(with_sign_in_step(403, br#"{"error":"Alexandria requires an API key"}"#).is_some());

    // A route's own rule, or a plain rate limit, is not a request to sign in.
    assert!(with_sign_in_step(429, br#"{"error":"Rate limit exceeded. Retry in 10s."}"#).is_none());
    assert!(with_sign_in_step(
      403,
      br#"{"error":"This route is not enabled for your team."}"#
    )
    .is_none());
    assert!(with_sign_in_step(402, br#"{"error":"Insufficient credits."}"#).is_none());
    assert!(with_sign_in_step(401, b"not json").is_none());
    assert!(with_sign_in_step(401, br#"{"error":{"code":1}}"#).is_none());
  }

  #[tokio::test]
  async fn a_keyless_refusal_gains_the_sign_in_step_and_a_keyed_one_does_not() {
    let base = refusing_cloud().await;
    let keyless = Cloud::new(base.clone(), None, CloudMode::Fallback).with_install_id("test");
    let answer = keyless
      .forward(
        reqwest::Method::POST,
        "/v2/search",
        Some("application/json"),
        bytes::Bytes::from_static(b"{}"),
        None,
        None,
      )
      .await
      .unwrap();
    assert_eq!(answer.status, 429);
    let text = String::from_utf8_lossy(&answer.body).to_string();
    assert!(text.contains("firecrawl-local login"), "{text}");
    assert!(!text.contains("Authorization"), "{text}");

    // A caller who sent a key gets the cloud's words as they came.
    let with_client_key = keyless
      .forward(
        reqwest::Method::POST,
        "/v2/search",
        Some("application/json"),
        bytes::Bytes::from_static(b"{}"),
        Some("fc-client"),
        None,
      )
      .await
      .unwrap();
    let text = String::from_utf8_lossy(&with_client_key.body).to_string();
    assert!(text.contains("Authorization"), "{text}");
    assert!(!text.contains("firecrawl-local login"), "{text}");
  }

  #[test]
  fn a_blocked_page_says_why_it_is_empty() {
    let off = blocked_warning(403, CloudMode::Off, None);
    assert!(
      off.contains("status 403") && off.contains("FIRECRAWL_CLOUD"),
      "{off}"
    );
    let refused = blocked_warning(
      403,
      CloudMode::Fallback,
      Some("Firecrawl cloud needs a sign-in for this. Run `firecrawl-local login`."),
    );
    assert!(refused.contains("firecrawl-local login"), "{refused}");
    assert!(refused.contains("did not fetch it either"), "{refused}");
    assert!(!blocked_warning(503, CloudMode::Fallback, None).contains("FIRECRAWL_CLOUD"));
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
  fn dot_segments_are_never_passed_on() {
    let cloud = |mode| Cloud::new("https://api.example.test".into(), None, mode);
    for path in [
      "/v2/search/../agent",
      "/v2/search/%2e%2e/agent",
      "/v2/search/%2E./agent",
      "/v2/search/./x",
      "/v2/search\\..\\agent",
      "/v2/search/..",
    ] {
      assert!(has_dot_segment(path), "{path}");
      assert!(!cloud(CloudMode::SearchOnly).allows(path), "{path}");
      assert!(!cloud(CloudMode::Fallback).allows(path), "{path}");
    }
    assert!(!has_dot_segment("/v2/search/v1.2/..hidden"));
    assert!(!has_dot_segment("/v2/search/a.b"));
  }

  #[tokio::test]
  async fn forward_refuses_a_path_it_would_not_send_as_written() {
    let cloud =
      Cloud::new(echo_cloud().await, None, CloudMode::SearchOnly).with_install_id("test-install");
    let refused = cloud
      .forward(
        reqwest::Method::POST,
        "/v2/search/../agent?x=1",
        Some("application/json"),
        bytes::Bytes::from_static(b"{}"),
        None,
        None,
      )
      .await;
    assert_eq!(refused.err().map(|e| e.status), Some(400));
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
    assert_eq!(CloudMode::parse(" Disabled "), Some(CloudMode::Off));
    assert_eq!(CloudMode::parse("no"), Some(CloudMode::Off));
    assert_eq!(CloudMode::parse("yes"), Some(CloudMode::Fallback));
  }

  #[test]
  fn a_setting_that_is_not_understood_turns_the_cloud_off() {
    assert_eq!(CloudMode::requested(None), None);
    assert_eq!(CloudMode::requested(Some("  ")), None);
    assert_eq!(
      CloudMode::requested(Some("search")),
      Some(CloudMode::SearchOnly)
    );
    assert_eq!(
      CloudMode::requested(Some("auto")),
      Some(CloudMode::Fallback)
    );
    assert_eq!(CloudMode::requested(Some("offf")), Some(CloudMode::Off));
    assert_eq!(CloudMode::requested(Some("nope")), Some(CloudMode::Off));
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
