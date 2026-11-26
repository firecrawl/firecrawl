//! Environment and CLI configuration for the NuQ prefetch worker with
//! automatic credential redaction in debug output, logs, and summaries.

use std::ffi::OsString;
use std::fmt;

use thiserror::Error;
use url::Url;

use crate::pg::{PgConnectionSettings, parse_pg_connection_settings};

/// Default HTTP port for `/health` and `/metrics`, matching `apps/api/src/config.ts`.
pub const DEFAULT_PORT: u16 = 3011;

/// Secret-bearing string whose `Debug` implementation always redacts its value.
#[derive(Clone, PartialEq, Eq)]
pub struct RedactedString(String);

impl RedactedString {
  /// Wraps a sensitive string value.
  #[must_use]
  pub fn new(value: impl Into<String>) -> Self {
    Self(value.into())
  }

  /// Exposes the underlying secret value to callers that need it for network I/O.
  #[must_use]
  pub fn expose(&self) -> &str {
    &self.0
  }
}

impl fmt::Debug for RedactedString {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.write_str("[REDACTED]")
  }
}

/// Parsed CLI command for the standalone binary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CliCommand {
  Run,
  CheckConfig,
  Help,
  Version,
}

/// Configuration and CLI parsing errors.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum ConfigError {
  #[error("CLI argument is not valid UTF-8")]
  InvalidUtf8Arg,
  #[error("unknown CLI argument: {0}")]
  UnknownArg(String),
  #[error("missing required environment variable NUQ_DATABASE_URL")]
  MissingDatabaseUrl,
  #[error("invalid NUQ_DATABASE_URL: {0}")]
  InvalidDatabaseUrl(String),
  #[error("invalid NUQ_RABBITMQ_URL: {0}")]
  InvalidRabbitmqUrl(String),
  #[error("invalid NUQ_PREFETCH_WORKER_PORT: expected integer in 1..=65535")]
  InvalidPort,
  #[error("invalid NUQ_PREFETCH_WORKER_HEARTBEAT_URL: {0}")]
  InvalidHeartbeatUrl(String),
}

/// Parses CLI arguments for the standalone binary without panicking on
/// non-UTF-8 arguments and without echoing flag values that may carry secrets.
pub fn parse_cli_args<I, S>(args: I) -> Result<CliCommand, ConfigError>
where
  I: IntoIterator<Item = S>,
  S: Into<OsString>,
{
  let mut command = CliCommand::Run;
  for raw_arg in args {
    let arg = raw_arg
      .into()
      .into_string()
      .map_err(|_| ConfigError::InvalidUtf8Arg)?;
    match arg.as_str() {
      "--check-config" => command = CliCommand::CheckConfig,
      "-h" | "--help" => return Ok(CliCommand::Help),
      "-V" | "--version" => return Ok(CliCommand::Version),
      other => {
        let safe_name = if other.starts_with('-') {
          let flag_name = other.split_once('=').map_or(other, |(flag, _)| flag);
          if flag_name.contains("://") || flag_name.contains('@') {
            "<redacted>"
          } else {
            flag_name
          }
        } else {
          "<positional>"
        };
        return Err(ConfigError::UnknownArg(safe_name.to_owned()));
      }
    }
  }
  Ok(command)
}

/// Runtime configuration for `firecrawl-nuq-prefetch`.
#[derive(Debug, Clone)]
pub struct WorkerConfig {
  pub database_url: RedactedString,
  pub pg_settings: PgConnectionSettings,
  pub rabbitmq_url: Option<RedactedString>,
  pub port: u16,
  pub heartbeat_url: Option<RedactedString>,
  pub pod_name: Option<String>,
}

impl WorkerConfig {
  /// Loads and validates configuration from the process environment.
  pub fn from_env() -> Result<Self, ConfigError> {
    Self::from_lookup(|key| std::env::var(key).ok())
  }

  /// Loads and validates configuration using a custom lookup function.
  pub fn from_lookup<F>(lookup: F) -> Result<Self, ConfigError>
  where
    F: Fn(&str) -> Option<String>,
  {
    let raw_db = lookup("NUQ_DATABASE_URL")
      .map(|v| v.trim().to_owned())
      .filter(|v| !v.is_empty())
      .ok_or(ConfigError::MissingDatabaseUrl)?;

    let pg_settings = parse_pg_connection_settings(&raw_db)
      .map_err(|err| ConfigError::InvalidDatabaseUrl(err.to_string()))?;

    let rabbitmq_url = match lookup("NUQ_RABBITMQ_URL")
      .map(|v| v.trim().to_owned())
      .filter(|v| !v.is_empty())
    {
      Some(raw) => {
        validate_amqp_url(&raw)?;
        Some(RedactedString::new(raw))
      }
      None => None,
    };

    let port = match lookup("NUQ_PREFETCH_WORKER_PORT")
      .map(|v| v.trim().to_owned())
      .filter(|v| !v.is_empty())
    {
      Some(raw) => {
        let parsed = raw.parse::<u16>().map_err(|_| ConfigError::InvalidPort)?;
        if parsed == 0 {
          return Err(ConfigError::InvalidPort);
        }
        parsed
      }
      None => DEFAULT_PORT,
    };

    let heartbeat_url = match lookup("NUQ_PREFETCH_WORKER_HEARTBEAT_URL")
      .map(|v| v.trim().to_owned())
      .filter(|v| !v.is_empty())
    {
      Some(raw) => {
        validate_http_url(&raw)?;
        Some(RedactedString::new(raw))
      }
      None => None,
    };

    // Match `firecrawl_telemetry::resource_from_process_env()`: omit when unset/blank.
    let pod_name = lookup("NUQ_POD_NAME")
      .map(|v| v.trim().to_owned())
      .filter(|v| !v.is_empty());

    Ok(Self {
      database_url: RedactedString::new(raw_db),
      pg_settings,
      rabbitmq_url,
      port,
      heartbeat_url,
      pod_name,
    })
  }

  /// Returns a JSON summary safe for logs and `--check-config`, with all
  /// credentials and secret URL paths redacted.
  #[must_use]
  pub fn redacted_summary(&self) -> String {
    let summary = serde_json::json!({
      "database": self.pg_settings.redacted_endpoint(),
      "databaseSslMode": self.pg_settings.ssl_mode().as_str(),
      "rabbitmq": self.rabbitmq_url.as_ref().map(|u| redact_amqp_url(u.expose())),
      "port": self.port,
      "heartbeatConfigured": self.heartbeat_url.is_some(),
      "podName": self.pod_name,
    });
    summary.to_string()
  }
}

fn validate_amqp_url(raw: &str) -> Result<(), ConfigError> {
  let parsed = Url::parse(raw)
    .map_err(|_| ConfigError::InvalidRabbitmqUrl("malformed AMQP URL".to_owned()))?;
  match parsed.scheme() {
    "amqp" | "amqps" => {}
    other => {
      return Err(ConfigError::InvalidRabbitmqUrl(format!(
        "unsupported scheme \"{other}\" (expected amqp or amqps)"
      )));
    }
  }
  if parsed.host_str().is_none() {
    return Err(ConfigError::InvalidRabbitmqUrl(
      "missing broker host".to_owned(),
    ));
  }
  Ok(())
}

fn validate_http_url(raw: &str) -> Result<(), ConfigError> {
  let parsed = Url::parse(raw)
    .map_err(|_| ConfigError::InvalidHeartbeatUrl("malformed HTTP URL".to_owned()))?;
  match parsed.scheme() {
    "http" | "https" => {}
    other => {
      return Err(ConfigError::InvalidHeartbeatUrl(format!(
        "unsupported scheme \"{other}\" (expected http or https)"
      )));
    }
  }
  if parsed.host_str().is_none() {
    return Err(ConfigError::InvalidHeartbeatUrl("missing host".to_owned()));
  }
  Ok(())
}

/// Redacts credentials, virtual host path, and query parameters from an AMQP URL.
#[must_use]
pub fn redact_amqp_url(raw: &str) -> String {
  let Ok(parsed) = Url::parse(raw) else {
    return "[REDACTED]".to_owned();
  };
  let scheme = parsed.scheme();
  let host = parsed.host_str().unwrap_or("unknown");
  let auth = if !parsed.username().is_empty() || parsed.password().is_some() {
    "***@"
  } else {
    ""
  };
  let port = parsed.port().map(|p| format!(":{p}")).unwrap_or_default();
  let path = if parsed.path().is_empty() || parsed.path() == "/" {
    ""
  } else {
    "/[REDACTED]"
  };
  format!("{scheme}://{auth}{host}{port}{path}")
}

/// Redacts credentials, path, and query from an HTTP heartbeat URL.
#[must_use]
pub fn redact_http_url(raw: &str) -> String {
  let Ok(parsed) = Url::parse(raw) else {
    return "[REDACTED]".to_owned();
  };
  let scheme = parsed.scheme();
  let host = parsed.host_str().unwrap_or("unknown");
  let port = parsed.port().map(|p| format!(":{p}")).unwrap_or_default();
  format!("{scheme}://{host}{port}/[REDACTED]")
}

#[cfg(test)]
mod tests {
  use std::collections::HashMap;

  use super::*;

  #[test]
  fn redacted_string_hides_value_in_debug() {
    let secret = RedactedString::new("super-secret-password");
    assert_eq!(format!("{secret:?}"), "[REDACTED]");
    assert_eq!(secret.expose(), "super-secret-password");
  }

  #[test]
  fn parse_cli_args_handles_known_and_unknown_flags() {
    assert_eq!(parse_cli_args(Vec::<&str>::new()), Ok(CliCommand::Run));
    assert_eq!(
      parse_cli_args(["--check-config"]),
      Ok(CliCommand::CheckConfig)
    );
    assert_eq!(parse_cli_args(["-h"]), Ok(CliCommand::Help));
    assert_eq!(parse_cli_args(["--help"]), Ok(CliCommand::Help));
    assert_eq!(parse_cli_args(["-V"]), Ok(CliCommand::Version));
    assert_eq!(parse_cli_args(["--version"]), Ok(CliCommand::Version));
    assert_eq!(
      parse_cli_args(["--bogus"]),
      Err(ConfigError::UnknownArg("--bogus".to_owned()))
    );
    assert_eq!(
      parse_cli_args(["--database-url=postgres://u:secret@host/db"]),
      Err(ConfigError::UnknownArg("--database-url".to_owned()))
    );
    assert_eq!(
      parse_cli_args(["postgres://u:secret@host/db"]),
      Err(ConfigError::UnknownArg("<positional>".to_owned()))
    );
    assert_eq!(
      parse_cli_args(["postgres://u:secret@host/db?sslmode=require"]),
      Err(ConfigError::UnknownArg("<positional>".to_owned()))
    );
    assert_eq!(
      parse_cli_args(["--postgres://u:secret@host/db?sslmode=require"]),
      Err(ConfigError::UnknownArg("<redacted>".to_owned()))
    );
    #[cfg(unix)]
    {
      use std::os::unix::ffi::OsStringExt;
      let bad = OsString::from_vec(vec![0xFF, 0xFE]);
      assert_eq!(parse_cli_args([bad]), Err(ConfigError::InvalidUtf8Arg));
    }
  }

  #[test]
  fn worker_config_defaults_and_redacts_secrets() {
    let vars = HashMap::from([
      (
        "NUQ_DATABASE_URL",
        "postgres://dbuser:dbpass123@db.internal:5432/nuq?sslmode=verify-full",
      ),
      (
        "NUQ_RABBITMQ_URL",
        "amqps://rmquser:rmqpass456@mq.internal:5671/secret-vhost?heartbeat=30",
      ),
      (
        "NUQ_PREFETCH_WORKER_HEARTBEAT_URL",
        "https://uptime.example.com/api/v1/heartbeat/secret-token-789",
      ),
    ]);

    let cfg = WorkerConfig::from_lookup(|k| vars.get(k).map(|v| (*v).to_owned()));
    assert!(cfg.is_ok());
    let Ok(cfg) = cfg else { return };

    assert_eq!(cfg.port, DEFAULT_PORT);
    assert_eq!(cfg.pod_name, None);

    let summary = cfg.redacted_summary();
    assert!(!summary.contains("dbpass123"));
    assert!(!summary.contains("dbuser"));
    assert!(!summary.contains("rmqpass456"));
    assert!(!summary.contains("rmquser"));
    assert!(!summary.contains("secret-vhost"));
    assert!(!summary.contains("secret-token-789"));
    assert!(summary.contains("db.internal"));
    assert!(summary.contains("mq.internal"));
    assert!(summary.contains("\"heartbeatConfigured\":true"));

    let debug = format!("{cfg:?}");
    assert!(!debug.contains("dbpass123"));
    assert!(!debug.contains("rmqpass456"));
    assert!(!debug.contains("secret-vhost"));
    assert!(!debug.contains("secret-token-789"));
  }

  #[test]
  fn worker_config_allows_unset_rabbitmq_and_empty_port_defaults() {
    let vars = HashMap::from([
      ("NUQ_DATABASE_URL", "postgres://localhost:5432/postgres"),
      ("NUQ_RABBITMQ_URL", "   "),
      ("NUQ_PREFETCH_WORKER_PORT", ""),
      ("NUQ_POD_NAME", "pod-a"),
    ]);

    let cfg = WorkerConfig::from_lookup(|k| vars.get(k).map(|v| (*v).to_owned()));
    assert!(cfg.is_ok());
    let Ok(cfg) = cfg else { return };

    assert!(cfg.rabbitmq_url.is_none());
    assert_eq!(cfg.port, 3011);
    assert_eq!(cfg.pod_name.as_deref(), Some("pod-a"));
  }

  #[test]
  fn worker_config_rejects_invalid_port_and_missing_db() {
    assert_eq!(
      WorkerConfig::from_lookup(|_| None).err(),
      Some(ConfigError::MissingDatabaseUrl)
    );

    let bad_port = HashMap::from([
      ("NUQ_DATABASE_URL", "postgres://localhost:5432/postgres"),
      ("NUQ_PREFETCH_WORKER_PORT", "0"),
    ]);
    assert_eq!(
      WorkerConfig::from_lookup(|k| bad_port.get(k).map(|v| (*v).to_owned())).err(),
      Some(ConfigError::InvalidPort)
    );
  }
}
