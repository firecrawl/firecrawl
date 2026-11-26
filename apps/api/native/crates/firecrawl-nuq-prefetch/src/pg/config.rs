//! PostgreSQL connection string parsing with full `sslmode` support
//! (`disable`, `prefer`, `require`, `no-verify`, `verify-ca`, `verify-full`),
//! `sslrootcert` extraction, and default `application_name=nuq`.

use std::fmt;
use std::str::FromStr;
use std::time::Duration;

use thiserror::Error;
use tokio_postgres::config::Host;

const DEFAULT_APPLICATION_NAME: &str = "nuq";
const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// PostgreSQL TLS verification mode matching libpq semantics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PgSslMode {
  Disable,
  Prefer,
  Require,
  VerifyCa,
  VerifyFull,
}

impl PgSslMode {
  /// Returns the canonical PostgreSQL `sslmode` name.
  #[must_use]
  pub const fn as_str(self) -> &'static str {
    match self {
      Self::Disable => "disable",
      Self::Prefer => "prefer",
      Self::Require => "require",
      Self::VerifyCa => "verify-ca",
      Self::VerifyFull => "verify-full",
    }
  }

  fn parse(raw: &str) -> Result<Self, PgConfigError> {
    match raw {
      "disable" => Ok(Self::Disable),
      "prefer" => Ok(Self::Prefer),
      "require" | "no-verify" => Ok(Self::Require),
      "verify-ca" => Ok(Self::VerifyCa),
      "verify-full" => Ok(Self::VerifyFull),
      other => Err(PgConfigError::InvalidSslMode(other.to_owned())),
    }
  }

  /// `tokio_postgres::Config` only accepts `disable`, `prefer`, and `require`;
  /// certificate and hostname verification are enforced by our `rustls` verifier.
  const fn as_tokio_postgres_param(self) -> &'static str {
    match self {
      Self::Disable => "disable",
      Self::Prefer => "prefer",
      Self::Require | Self::VerifyCa | Self::VerifyFull => "require",
    }
  }
}

/// Errors returned when parsing `NUQ_DATABASE_URL`.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum PgConfigError {
  #[error("invalid sslmode \"{0}\"")]
  InvalidSslMode(String),
  #[error("invalid percent-encoding in connection URI query")]
  InvalidPercentEncoding,
  #[error("unterminated quoted value in libpq connection string")]
  UnterminatedQuote,
  #[error("could not parse PostgreSQL connection string (credentials redacted)")]
  ParseFailed,
}

/// Parsed, credential-safe PostgreSQL connection settings ready for pool creation.
#[derive(Clone)]
pub struct PgConnectionSettings {
  pg_config: tokio_postgres::Config,
  ssl_mode: PgSslMode,
  ssl_root_cert: Option<String>,
  redacted_endpoint: String,
}

impl fmt::Debug for PgConnectionSettings {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.debug_struct("PgConnectionSettings")
      .field("endpoint", &self.redacted_endpoint)
      .field("ssl_mode", &self.ssl_mode)
      .field("has_ssl_root_cert", &self.ssl_root_cert.is_some())
      .field("application_name", &self.pg_config.get_application_name())
      .finish()
  }
}

impl PgConnectionSettings {
  /// Returns the underlying `tokio_postgres::Config`.
  #[must_use]
  pub fn pg_config(&self) -> &tokio_postgres::Config {
    &self.pg_config
  }

  /// Returns the resolved PostgreSQL TLS mode.
  #[must_use]
  pub const fn ssl_mode(&self) -> PgSslMode {
    self.ssl_mode
  }

  /// Returns the optional `sslrootcert` path extracted from the connection string.
  #[must_use]
  pub fn ssl_root_cert(&self) -> Option<&str> {
    self.ssl_root_cert.as_deref()
  }

  /// Returns a credential-free `host:port/dbname` summary safe for logs.
  #[must_use]
  pub fn redacted_endpoint(&self) -> &str {
    &self.redacted_endpoint
  }
}

/// Parses a PostgreSQL URI or libpq key-value connection string, applying
/// `application_name=nuq` when unspecified and extracting `sslmode` / `sslrootcert`.
pub fn parse_pg_connection_settings(raw: &str) -> Result<PgConnectionSettings, PgConfigError> {
  let trimmed = raw.trim();
  let (sanitized, ssl_mode, ssl_root_cert) =
    if trimmed.starts_with("postgres://") || trimmed.starts_with("postgresql://") {
      preprocess_uri(trimmed)?
    } else {
      preprocess_kv(trimmed)?
    };

  let mut pg_config =
    tokio_postgres::Config::from_str(&sanitized).map_err(|_| PgConfigError::ParseFailed)?;

  if pg_config.get_application_name().is_none() {
    pg_config.application_name(DEFAULT_APPLICATION_NAME);
  }
  if pg_config.get_connect_timeout().is_none() {
    pg_config.connect_timeout(DEFAULT_CONNECT_TIMEOUT);
  }

  let redacted_endpoint = format_redacted_endpoint(&pg_config);

  Ok(PgConnectionSettings {
    pg_config,
    ssl_mode,
    ssl_root_cert,
    redacted_endpoint,
  })
}

fn preprocess_uri(raw: &str) -> Result<(String, PgSslMode, Option<String>), PgConfigError> {
  let Some((base, query)) = raw.split_once('?') else {
    return Ok((raw.to_owned(), PgSslMode::Prefer, None));
  };

  let mut ssl_mode = PgSslMode::Prefer;
  let mut ssl_root_cert = None;
  let mut forwarded = Vec::new();

  for pair in query.split('&') {
    if pair.is_empty() {
      continue;
    }
    let Some((raw_key, raw_val)) = pair.split_once('=') else {
      forwarded.push(pair.to_owned());
      continue;
    };
    let key = percent_decode(raw_key)?;
    let val = percent_decode(raw_val)?;
    match key.as_str() {
      "sslmode" => {
        ssl_mode = PgSslMode::parse(&val)?;
        forwarded.push(format!("sslmode={}", ssl_mode.as_tokio_postgres_param()));
      }
      "sslrootcert" => {
        if !val.is_empty() {
          ssl_root_cert = Some(val);
        }
      }
      "uselibpqcompat" => {}
      _ => forwarded.push(pair.to_owned()),
    }
  }

  let sanitized = if forwarded.is_empty() {
    base.to_owned()
  } else {
    format!("{base}?{}", forwarded.join("&"))
  };

  Ok((sanitized, ssl_mode, ssl_root_cert))
}

fn preprocess_kv(raw: &str) -> Result<(String, PgSslMode, Option<String>), PgConfigError> {
  let tokens = parse_libpq_kv(raw)?;
  let mut ssl_mode = PgSslMode::Prefer;
  let mut ssl_root_cert = None;
  let mut forwarded = Vec::new();

  for (key, val) in tokens {
    match key.as_str() {
      "sslmode" => {
        ssl_mode = PgSslMode::parse(&val)?;
        forwarded.push(format!("sslmode={}", ssl_mode.as_tokio_postgres_param()));
      }
      "sslrootcert" => {
        if !val.is_empty() {
          ssl_root_cert = Some(val);
        }
      }
      "uselibpqcompat" => {}
      _ => forwarded.push(format!("{key}={}", quote_libpq_value(&val))),
    }
  }

  Ok((forwarded.join(" "), ssl_mode, ssl_root_cert))
}

fn parse_libpq_kv(raw: &str) -> Result<Vec<(String, String)>, PgConfigError> {
  let mut chars = raw.chars().peekable();
  let mut pairs = Vec::new();

  loop {
    while chars.peek().is_some_and(|c| c.is_whitespace()) {
      chars.next();
    }
    if chars.peek().is_none() {
      break;
    }

    let mut key = String::new();
    while let Some(&c) = chars.peek() {
      if c == '=' || c.is_whitespace() {
        break;
      }
      key.push(c);
      chars.next();
    }

    while chars.peek().is_some_and(|c| c.is_whitespace()) {
      chars.next();
    }
    if chars.next() != Some('=') {
      return Err(PgConfigError::ParseFailed);
    }
    while chars.peek().is_some_and(|c| c.is_whitespace()) {
      chars.next();
    }

    let mut value = String::new();
    if chars.peek() == Some(&'\'') {
      chars.next();
      let mut closed = false;
      while let Some(c) = chars.next() {
        if c == '\\' {
          let escaped = chars.next().ok_or(PgConfigError::UnterminatedQuote)?;
          value.push(escaped);
        } else if c == '\'' {
          closed = true;
          break;
        } else {
          value.push(c);
        }
      }
      if !closed {
        return Err(PgConfigError::UnterminatedQuote);
      }
    } else {
      while let Some(&c) = chars.peek() {
        if c.is_whitespace() {
          break;
        }
        value.push(c);
        chars.next();
      }
    }

    pairs.push((key, value));
  }

  Ok(pairs)
}

fn quote_libpq_value(value: &str) -> String {
  if !value.is_empty()
    && !value
      .chars()
      .any(|c| c.is_whitespace() || c == '\'' || c == '\\')
  {
    return value.to_owned();
  }
  let mut out = String::with_capacity(value.len().saturating_add(2));
  out.push('\'');
  for c in value.chars() {
    if c == '\'' || c == '\\' {
      out.push('\\');
    }
    out.push(c);
  }
  out.push('\'');
  out
}

fn percent_decode(input: &str) -> Result<String, PgConfigError> {
  let bytes = input.as_bytes();
  let mut out = Vec::with_capacity(bytes.len());
  let mut idx = 0;

  while let Some(&b) = bytes.get(idx) {
    if b == b'%' {
      let hi = bytes
        .get(
          idx
            .checked_add(1)
            .ok_or(PgConfigError::InvalidPercentEncoding)?,
        )
        .and_then(|c| hex_val(*c))
        .ok_or(PgConfigError::InvalidPercentEncoding)?;
      let lo = bytes
        .get(
          idx
            .checked_add(2)
            .ok_or(PgConfigError::InvalidPercentEncoding)?,
        )
        .and_then(|c| hex_val(*c))
        .ok_or(PgConfigError::InvalidPercentEncoding)?;
      out.push((hi << 4) | lo);
      idx = idx
        .checked_add(3)
        .ok_or(PgConfigError::InvalidPercentEncoding)?;
    } else {
      out.push(b);
      idx = idx
        .checked_add(1)
        .ok_or(PgConfigError::InvalidPercentEncoding)?;
    }
  }

  String::from_utf8(out).map_err(|_| PgConfigError::InvalidPercentEncoding)
}

const fn hex_val(b: u8) -> Option<u8> {
  match b {
    b'0'..=b'9' => Some(b.wrapping_sub(b'0')),
    b'a'..=b'f' => Some(b.wrapping_sub(b'a').wrapping_add(10)),
    b'A'..=b'F' => Some(b.wrapping_sub(b'A').wrapping_add(10)),
    _ => None,
  }
}

fn format_redacted_endpoint(cfg: &tokio_postgres::Config) -> String {
  let hosts: Vec<String> = cfg
    .get_hosts()
    .iter()
    .enumerate()
    .map(|(i, host)| {
      let port = cfg
        .get_ports()
        .get(i)
        .copied()
        .or_else(|| cfg.get_ports().first().copied())
        .unwrap_or(5432);
      match host {
        Host::Tcp(h) => format!("{h}:{port}"),
        #[cfg(unix)]
        Host::Unix(p) => format!("unix:{}:{port}", p.display()),
      }
    })
    .collect();

  let host_str = if hosts.is_empty() {
    "localhost:5432".to_owned()
  } else {
    hosts.join(",")
  };
  let dbname = cfg.get_dbname().unwrap_or("postgres");
  format!("postgres://{host_str}/{dbname}")
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn sets_default_application_name_and_parses_all_sslmodes() {
    let cases = [
      ("disable", PgSslMode::Disable),
      ("prefer", PgSslMode::Prefer),
      ("require", PgSslMode::Require),
      ("no-verify", PgSslMode::Require),
      ("verify-ca", PgSslMode::VerifyCa),
      ("verify-full", PgSslMode::VerifyFull),
    ];

    for (raw_mode, expected) in cases {
      let url = format!("postgres://user:secret@pg.example.com:6432/nuq?sslmode={raw_mode}");
      let parsed = parse_pg_connection_settings(&url);
      assert!(parsed.is_ok(), "mode {raw_mode} failed: {parsed:?}");
      let Ok(settings) = parsed else { continue };
      assert_eq!(settings.ssl_mode(), expected);
      assert_eq!(settings.pg_config().get_application_name(), Some("nuq"));
      assert_eq!(
        settings.redacted_endpoint(),
        "postgres://pg.example.com:6432/nuq"
      );
      let dbg = format!("{settings:?}");
      assert!(!dbg.contains("secret"));
    }
  }

  #[test]
  fn extracts_sslrootcert_and_handles_libpq_kv() {
    let uri = "postgresql://u:p%40ss@10.0.0.1:5432/db?sslmode=verify-ca&sslrootcert=%2Fetc%2Fca.pem&uselibpqcompat=true";
    let settings = parse_pg_connection_settings(uri);
    assert!(settings.is_ok());
    let Ok(settings) = settings else { return };
    assert_eq!(settings.ssl_mode(), PgSslMode::VerifyCa);
    assert_eq!(settings.ssl_root_cert(), Some("/etc/ca.pem"));

    let kv = "host=127.0.0.1 port=6432 user=nuq password='my secret' dbname=nuq sslmode=verify-full sslrootcert='/tmp/root ca.pem'";
    let kv_settings = parse_pg_connection_settings(kv);
    assert!(kv_settings.is_ok());
    let Ok(kv_settings) = kv_settings else { return };
    assert_eq!(kv_settings.ssl_mode(), PgSslMode::VerifyFull);
    assert_eq!(kv_settings.ssl_root_cert(), Some("/tmp/root ca.pem"));
    assert_eq!(kv_settings.pg_config().get_application_name(), Some("nuq"));
  }

  #[test]
  fn rejects_unknown_sslmode_without_leaking_password() {
    let err = parse_pg_connection_settings("postgres://u:supersecret@host/db?sslmode=bogus");
    assert_eq!(
      err.err(),
      Some(PgConfigError::InvalidSslMode("bogus".to_owned()))
    );
  }
}
