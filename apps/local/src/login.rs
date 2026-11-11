//! One-step sign-in: the same browser handshake as `firecrawl login`.
//!
//! The engine makes a link, the person opens it and signs in, and the key
//! comes back by itself and is saved where the Firecrawl CLI keeps its login.
//! Nobody copies a key. The secret half of the handshake (the verifier) never
//! leaves this process except in the POST that redeems it.

use std::time::{Duration, Instant};

use base64::Engine as _;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const WEB_URL: &str = "https://www.firecrawl.dev";
const POLL_EVERY: Duration = Duration::from_secs(2);

#[derive(Clone)]
pub struct LoginSession {
  pub url: String,
  session_id: String,
  code_verifier: String,
  web_url: String,
}

pub struct SignedIn {
  pub api_key: String,
  pub api_url: Option<String>,
  pub team_name: Option<String>,
}

pub enum Poll {
  Pending,
  Complete(SignedIn),
  /// Rate limited or a server fault: keep polling.
  Busy(String),
  /// A refusal that more polling will not change.
  Failed(String),
}

fn random_bytes<const N: usize>() -> Result<[u8; N], String> {
  let mut buf = [0u8; N];
  getrandom::fill(&mut buf).map_err(|e| format!("no secure random source: {e}"))?;
  Ok(buf)
}

fn challenge_for(verifier: &str) -> String {
  base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

impl LoginSession {
  pub fn start() -> Result<Self, String> {
    let web_url = std::env::var("FIRECRAWL_WEB_URL")
      .ok()
      .filter(|u| !u.trim().is_empty())
      .unwrap_or_else(|| WEB_URL.to_string());
    let session_id: String = random_bytes::<32>()?
      .iter()
      .map(|b| format!("{b:02x}"))
      .collect();
    let code_verifier =
      base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random_bytes::<32>()?);
    let url = format!(
      "{}/cli-auth?code_challenge={}#session_id={}",
      web_url.trim_end_matches('/'),
      challenge_for(&code_verifier),
      session_id
    );
    Ok(Self {
      url,
      session_id,
      code_verifier,
      web_url,
    })
  }

  pub async fn poll(&self, client: &reqwest::Client) -> Poll {
    let resp = client
      .post(format!(
        "{}/api/auth/cli/status",
        self.web_url.trim_end_matches('/')
      ))
      .timeout(Duration::from_secs(10))
      .json(&json!({ "session_id": self.session_id, "code_verifier": self.code_verifier }))
      .send()
      .await;
    let resp = match resp {
      Ok(r) => r,
      Err(e) => return Poll::Busy(format!("could not reach {}: {e}", self.web_url)),
    };
    let status = resp.status().as_u16();
    if status == 429 || status >= 500 {
      return Poll::Busy(format!("server answered {status}"));
    }
    if !(200..300).contains(&status) {
      return Poll::Failed(format!("server answered {status}"));
    }
    let data: Value = match resp.json().await {
      Ok(v) => v,
      Err(e) => return Poll::Busy(format!("unreadable reply: {e}")),
    };
    let field = |name: &str| data.get(name).and_then(Value::as_str).map(str::to_string);
    match (data.get("status").and_then(Value::as_str), field("apiKey")) {
      (Some("complete"), Some(api_key)) if !api_key.is_empty() => Poll::Complete(SignedIn {
        api_key,
        api_url: field("apiUrl"),
        team_name: field("teamName"),
      }),
      _ => Poll::Pending,
    }
  }

  /// Poll until the person finishes signing in, or `limit` passes.
  pub async fn wait(&self, limit: Duration) -> Result<SignedIn, String> {
    let client = reqwest::Client::new();
    let started = Instant::now();
    loop {
      match self.poll(&client).await {
        Poll::Complete(s) => return Ok(s),
        Poll::Failed(detail) => return Err(format!("sign-in was refused: {detail}")),
        Poll::Pending | Poll::Busy(_) => {}
      }
      if started.elapsed() >= limit {
        return Err("sign-in was not finished in time".to_string());
      }
      tokio::time::sleep(POLL_EVERY).await;
    }
  }
}

/// Save the login where the Firecrawl CLI keeps it, readable only by the
/// user, so the CLI and the engine share one sign-in.
pub fn save(signed_in: &SignedIn) -> Result<std::path::PathBuf, String> {
  let path =
    crate::cloud::cli_credentials_path().ok_or("no home directory to save the login in")?;
  if let Some(dir) = path.parent() {
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
  }
  let mut body = json!({ "apiKey": signed_in.api_key });
  if let Some(url) = &signed_in.api_url {
    body["apiUrl"] = Value::String(url.clone());
  }
  let text = serde_json::to_string_pretty(&body).map_err(|e| e.to_string())?;
  std::fs::write(&path, text).map_err(|e| format!("{}: {e}", path.display()))?;
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
  }
  Ok(path)
}

/// Open a URL in the default browser. Best effort.
pub fn open_browser(url: &str) -> bool {
  let result = if cfg!(target_os = "macos") {
    std::process::Command::new("open").arg(url).status()
  } else if cfg!(target_os = "windows") {
    std::process::Command::new("cmd")
      .args(["/C", "start", "", url])
      .status()
  } else {
    std::process::Command::new("xdg-open").arg(url).status()
  };
  matches!(result, Ok(s) if s.success())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn challenge_matches_the_pkce_test_vector() {
    // RFC 7636 appendix B.
    assert_eq!(
      challenge_for("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    );
  }

  #[test]
  fn session_link_has_the_challenge_but_not_the_verifier() {
    let s = LoginSession::start().unwrap();
    assert!(s
      .url
      .starts_with("https://www.firecrawl.dev/cli-auth?code_challenge="));
    assert!(s.url.contains(&challenge_for(&s.code_verifier)));
    assert!(!s.url.contains(&s.code_verifier));
    assert_eq!(s.session_id.len(), 64);
    assert!(s.url.ends_with(&format!("#session_id={}", s.session_id)));
  }
}
