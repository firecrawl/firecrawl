use std::process::Command;

const BIN_PATH: &str = env!("CARGO_BIN_EXE_firecrawl-worker");

#[test]
fn cli_help_and_version_exit_zero() {
  let version = Command::new(BIN_PATH).arg("--version").output();
  assert!(version.is_ok());
  if let Ok(out) = version {
    assert!(out.status.success());
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.starts_with("firecrawl-worker "));
  }

  let help = Command::new(BIN_PATH).arg("--help").output();
  assert!(help.is_ok());
  if let Ok(out) = help {
    assert!(out.status.success());
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("firecrawl-worker <ROLE>"));
    assert!(stdout.contains("nuq-prefetch"));
  }

  let role_help = Command::new(BIN_PATH)
    .args(["nuq-prefetch", "--help"])
    .output();
  assert!(role_help.is_ok());
  if let Ok(out) = role_help {
    assert!(out.status.success());
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("firecrawl-worker nuq-prefetch"));
    assert!(stdout.contains("--check-config"));
    assert!(stdout.contains("NUQ_DATABASE_URL"));
  }
}

#[test]
fn cli_rejects_unknown_argument_with_exit_code_2_without_leaking_values() {
  for (args, expected) in [
    (&[][..], "a worker role is required"),
    (
      &["postgres://u:supersecretpg@host/db"][..],
      "unknown worker role",
    ),
  ] {
    let res = Command::new(BIN_PATH).args(args).output();
    assert!(res.is_ok());
    if let Ok(out) = res {
      assert_eq!(out.status.code(), Some(2));
      let stderr = String::from_utf8_lossy(&out.stderr);
      assert!(stderr.contains(expected));
      assert!(!stderr.contains("supersecretpg"));
    }
  }

  for (arg, expected) in [
    (
      "--database-url=postgres://u:supersecretpg@host/db",
      "--database-url",
    ),
    (
      "postgres://u:supersecretpg@host/db?sslmode=require",
      "<positional>",
    ),
  ] {
    let res = Command::new(BIN_PATH).args(["nuq-prefetch", arg]).output();
    assert!(res.is_ok());
    if let Ok(out) = res {
      assert_eq!(out.status.code(), Some(2));
      let stderr = String::from_utf8_lossy(&out.stderr);
      assert!(stderr.contains(expected));
      assert!(!stderr.contains("supersecretpg"));
    }
  }
}

#[test]
fn cli_check_config_validates_and_redacts_secrets() {
  let missing = Command::new(BIN_PATH)
    .args(["nuq-prefetch", "--check-config"])
    .env_clear()
    .output();
  assert!(missing.is_ok());
  if let Ok(out) = missing {
    assert!(!out.status.success());
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("NUQ_DATABASE_URL"));
  }

  let invalid_ca = Command::new(BIN_PATH)
    .args(["nuq-prefetch", "--check-config"])
    .env_clear()
    .env(
      "NUQ_DATABASE_URL",
      "postgres://nuq@localhost/nuq?sslmode=verify-full&sslrootcert=/nonexistent/ca-bundle.pem",
    )
    .output();
  assert!(invalid_ca.is_ok());
  if let Ok(out) = invalid_ca {
    assert_eq!(out.status.code(), Some(1));
    assert!(out.stdout.is_empty());
    assert!(String::from_utf8_lossy(&out.stderr).contains("failed to read sslrootcert PEM file"));
  }

  let ok = Command::new(BIN_PATH)
    .args(["nuq-prefetch", "--check-config"])
    .env_clear()
    .env(
      "NUQ_DATABASE_URL",
      "postgres://secretuser:topsecretpg@pg.internal:6432/nuq?sslmode=require",
    )
    .env(
      "NUQ_RABBITMQ_URL",
      "amqps://rmquser:topsecretrmq@mq.internal:5671/secret-vhost",
    )
    .env("NUQ_PREFETCH_WORKER_PORT", "3019")
    .env(
      "NUQ_PREFETCH_WORKER_HEARTBEAT_URL",
      "https://hb.example.com/ping?token=topsecrethb",
    )
    .env("NUQ_POD_NAME", "pod-7")
    .output();
  assert!(ok.is_ok());
  if let Ok(out) = ok {
    assert!(out.status.success());
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    for secret in [
      "secretuser",
      "topsecretpg",
      "rmquser",
      "topsecretrmq",
      "secret-vhost",
      "topsecrethb",
    ] {
      assert!(!stdout.contains(secret), "leaked secret {secret} in stdout");
      assert!(!stderr.contains(secret), "leaked secret {secret} in stderr");
    }
    let parsed: Result<serde_json::Value, _> = serde_json::from_str(stdout.trim());
    assert!(parsed.is_ok());
    if let Ok(v) = parsed {
      assert_eq!(
        v.get("port").and_then(serde_json::Value::as_u64),
        Some(3019)
      );
      assert_eq!(
        v.get("podName").and_then(serde_json::Value::as_str),
        Some("pod-7")
      );
      assert_eq!(
        v.get("databaseSslMode").and_then(serde_json::Value::as_str),
        Some("require")
      );
      assert_eq!(
        v.get("heartbeatConfigured")
          .and_then(serde_json::Value::as_bool),
        Some(true)
      );
    }
  }
}
