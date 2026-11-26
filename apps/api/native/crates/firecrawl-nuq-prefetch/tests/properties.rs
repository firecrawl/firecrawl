use std::collections::{HashMap, HashSet};

use hegel::{TestCase, generators as gs};
use serde_json::{Map, Value, json};

use firecrawl_nuq_prefetch::{
  NuqJob, PgSslMode, WorkerConfig, format_epoch_millis_iso_utc, parse_pg_connection_settings,
  parse_pg_timestamp_to_epoch_millis, parse_pg_timestamp_to_iso_utc, stored_zero_data_retention,
};

#[hegel::composite]
fn ascii_token(tc: &TestCase, min_len: usize, max_len: usize) -> String {
  let alphabet: Vec<char> = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    .chars()
    .collect();
  let len = tc.draw(
    gs::integers::<usize>()
      .min_value(min_len)
      .max_value(max_len),
  );
  let mut out = String::with_capacity(len);
  for _ in 0..len {
    let ch = tc.draw(gs::sampled_from(&alphabet));
    out.push(ch);
  }
  out
}

/// Every `NuqJob` decoded from PostgreSQL serializes to the exact camelCase wire
/// contract expected by `rabbitRowToJob`, omits null optional fields, always
/// retains `data`, round-trips cleanly, and never leaks payloads in `Debug`.
#[hegel::test]
fn nuq_job_wire_json_matches_rabbit_row_to_job_contract(tc: TestCase) {
  let id = tc.draw(ascii_token(8, 36));
  let status = tc.draw(gs::sampled_from(&[
    "queued",
    "active",
    "completed",
    "failed",
    "backlog",
  ]));
  let created_ms = tc.draw(
    gs::integers::<i64>()
      .min_value(-2_208_988_800_000)
      .max_value(4_102_444_800_000),
  );
  let created_iso_res = format_epoch_millis_iso_utc(created_ms);
  assert!(
    created_iso_res.is_ok(),
    "valid epoch ms failed to format: {created_iso_res:?}"
  );
  let Ok(created_iso) = created_iso_res else {
    return;
  };
  let priority = tc.draw(gs::integers::<i32>());

  let secret_marker = format!("SECRET_DATA_{}", tc.draw(ascii_token(10, 16)));
  let data_col = if tc.draw(gs::booleans()) {
    Some(
      json!({
        "url": format!("https://example.com/{secret_marker}"),
        "ctx": { "zeroDataRetention": tc.draw(gs::booleans()) }
      })
      .to_string(),
    )
  } else {
    None
  };

  let finished_col = if tc.draw(gs::booleans()) {
    let fin_ms = tc.draw(
      gs::integers::<i64>()
        .min_value(-2_208_988_800_000)
        .max_value(4_102_444_800_000),
    );
    format_epoch_millis_iso_utc(fin_ms).ok()
  } else {
    None
  };

  let listen_col = if tc.draw(gs::booleans()) {
    Some(tc.draw(ascii_token(1, 24)))
  } else {
    None
  };

  let returnvalue_kind = tc.draw(gs::integers::<u8>().max_value(2));
  let returnvalue_col = match returnvalue_kind {
    0 => None,
    1 => Some("null".to_owned()),
    _ => Some(json!({ "markdown": secret_marker }).to_string()),
  };

  let failed_col = if tc.draw(gs::booleans()) {
    Some(format!("err_{secret_marker}"))
  } else {
    None
  };
  let lock_col = if tc.draw(gs::booleans()) {
    Some(tc.draw(ascii_token(8, 36)))
  } else {
    None
  };
  let owner_col = if tc.draw(gs::booleans()) {
    Some(tc.draw(ascii_token(8, 36)))
  } else {
    None
  };
  let group_col = if tc.draw(gs::booleans()) {
    Some(tc.draw(ascii_token(8, 36)))
  } else {
    None
  };

  let priority_str = priority.to_string();
  let cols = [
    Some(id.as_str()),
    Some(status),
    Some(created_iso.as_str()),
    Some(priority_str.as_str()),
    data_col.as_deref(),
    finished_col.as_deref(),
    listen_col.as_deref(),
    returnvalue_col.as_deref(),
    failed_col.as_deref(),
    lock_col.as_deref(),
    owner_col.as_deref(),
    group_col.as_deref(),
  ];

  let decoded = NuqJob::from_pg_columns(&cols);
  assert!(decoded.is_ok(), "decode failed: {decoded:?}");
  let Ok(job) = decoded else { return };

  let debug_output = format!("{job:?}");
  assert!(!debug_output.contains(&secret_marker));

  let wire_str = serde_json::to_string(&job);
  assert!(wire_str.is_ok());
  let Ok(wire_str) = wire_str else { return };

  let wire_val: Result<Value, _> = serde_json::from_str(&wire_str);
  assert!(matches!(wire_val, Ok(Value::Object(_))));
  let Ok(Value::Object(map)) = wire_val else {
    return;
  };

  let allowed_keys: HashSet<&str> = HashSet::from([
    "id",
    "status",
    "createdAt",
    "priority",
    "data",
    "finishedAt",
    "listenChannelId",
    "returnvalue",
    "failedReason",
    "lock",
    "ownerId",
    "groupId",
  ]);
  for key in map.keys() {
    assert!(allowed_keys.contains(key.as_str()), "unexpected key {key}");
  }

  assert_eq!(map.get("id").and_then(Value::as_str), Some(id.as_str()));
  assert_eq!(map.get("status").and_then(Value::as_str), Some(status));
  assert_eq!(
    map.get("createdAt").and_then(Value::as_str),
    Some(created_iso.as_str())
  );
  assert_eq!(
    map.get("priority").and_then(Value::as_i64),
    Some(i64::from(priority))
  );
  assert!(map.contains_key("data"));
  if data_col.is_none() {
    assert_eq!(map.get("data"), Some(&Value::Null));
  }

  assert_eq!(map.contains_key("finishedAt"), finished_col.is_some());
  assert_eq!(map.contains_key("listenChannelId"), listen_col.is_some());
  assert_eq!(map.contains_key("returnvalue"), returnvalue_kind == 2);
  assert_eq!(map.contains_key("failedReason"), failed_col.is_some());
  assert_eq!(map.contains_key("lock"), lock_col.is_some());
  assert_eq!(map.contains_key("ownerId"), owner_col.is_some());
  assert_eq!(map.contains_key("groupId"), group_col.is_some());

  let roundtrip: Result<NuqJob, _> = serde_json::from_str(&wire_str);
  assert_eq!(roundtrip.ok(), Some(job));
}

/// Arbitrary UTC epoch milliseconds formatted with timezone offsets and extra
/// sub-millisecond microseconds always truncate identically to JS `Date`.
#[hegel::test]
fn pg_timestamp_roundtrips_across_offsets_and_microseconds(tc: TestCase) {
  let epoch_ms = tc.draw(
    gs::integers::<i64>()
      .min_value(-2_208_988_800_000)
      .max_value(7_258_118_400_000),
  );
  let extra_micros = tc.draw(gs::integers::<u16>().max_value(999));
  let tz_sign = if tc.draw(gs::booleans()) {
    1_i64
  } else {
    -1_i64
  };
  let tz_hours = tc.draw(gs::integers::<u8>().max_value(14));
  let tz_mins = if tz_hours == 14 {
    0
  } else {
    tc.draw(gs::integers::<u8>().max_value(59))
  };
  let tz_secs = if tz_hours == 14 {
    0
  } else {
    tc.draw(gs::integers::<u8>().max_value(59))
  };
  let include_tz_secs = tc.draw(gs::booleans());
  let include_tz_mins = include_tz_secs || tz_mins != 0 || tc.draw(gs::booleans());
  let use_space = tc.draw(gs::booleans());

  let offset_secs = tz_sign.saturating_mul(
    i64::from(tz_hours)
      .saturating_mul(3_600)
      .saturating_add(i64::from(tz_mins).saturating_mul(60))
      .saturating_add(if include_tz_secs {
        i64::from(tz_secs)
      } else {
        0
      }),
  );

  let local_ms = epoch_ms.saturating_add(offset_secs.saturating_mul(1_000));
  let local_iso_res = format_epoch_millis_iso_utc(local_ms);
  assert!(
    local_iso_res.is_ok(),
    "failed to format local timestamp: {local_iso_res:?}"
  );
  let Ok(local_iso) = local_iso_res else {
    return;
  };
  let local_core = local_iso.trim_end_matches('Z');
  let local_body = if use_space {
    local_core.replacen('T', " ", 1)
  } else {
    local_core.to_owned()
  };

  let sign_char = if tz_sign >= 0 { '+' } else { '-' };
  let tz_suffix = if include_tz_secs {
    format!("{sign_char}{tz_hours:02}:{tz_mins:02}:{tz_secs:02}")
  } else if include_tz_mins {
    format!("{sign_char}{tz_hours:02}:{tz_mins:02}")
  } else {
    format!("{sign_char}{tz_hours:02}")
  };

  let pg_text = format!("{local_body}{extra_micros:03}{tz_suffix}");
  let parsed_ms = parse_pg_timestamp_to_epoch_millis(&pg_text);
  assert_eq!(parsed_ms, Ok(epoch_ms), "pg_text={pg_text}");

  let expected_iso = format_epoch_millis_iso_utc(epoch_ms);
  assert_eq!(parse_pg_timestamp_to_iso_utc(&pg_text), expected_iso);
}

/// `stored_zero_data_retention` prioritizes non-null `ctx.zeroDataRetention`,
/// falls back to top-level `zeroDataRetention`, and fails closed on non-bools.
#[hegel::test]
fn stored_zdr_obeys_precedence_and_fail_closed_semantics(tc: TestCase) {
  let gen_flag = |tc: &TestCase| -> Option<Value> {
    match tc.draw(gs::integers::<u8>().max_value(4)) {
      0 => None,
      1 => Some(Value::Null),
      2 => Some(Value::Bool(false)),
      3 => Some(Value::Bool(true)),
      _ => Some(Value::String("truthy".to_owned())),
    }
  };

  let ctx_flag = gen_flag(&tc);
  let top_flag = gen_flag(&tc);

  let mut root = Map::new();
  if let Some(ref top) = top_flag {
    root.insert("zeroDataRetention".to_owned(), top.clone());
  }
  if tc.draw(gs::booleans()) {
    let mut ctx = Map::new();
    if let Some(ref cf) = ctx_flag {
      ctx.insert("zeroDataRetention".to_owned(), cf.clone());
    }
    root.insert("ctx".to_owned(), Value::Object(ctx));
  }

  let effective_ctx = root
    .get("ctx")
    .and_then(Value::as_object)
    .and_then(|c| c.get("zeroDataRetention"))
    .filter(|v| !v.is_null());
  let effective = effective_ctx.or_else(|| top_flag.as_ref().filter(|v| !v.is_null()));
  let expected = effective.is_some_and(|v| v != &Value::Bool(false));

  assert_eq!(
    stored_zero_data_retention(Some(&Value::Object(root))),
    expected
  );
}

/// Credentials in `NUQ_DATABASE_URL`, `NUQ_RABBITMQ_URL`, and
/// `NUQ_PREFETCH_WORKER_HEARTBEAT_URL` never appear in summaries or `Debug`.
#[hegel::test]
fn config_redaction_never_leaks_credentials_across_sslmodes(tc: TestCase) {
  let db_pass = format!("DBPASS_{}", tc.draw(ascii_token(10, 18)));
  let rmq_pass = format!("RMQPASS_{}", tc.draw(ascii_token(10, 18)));
  let hb_token = format!("HBTOKEN_{}", tc.draw(ascii_token(10, 18)));
  let sslmode = tc.draw(gs::sampled_from(&[
    "disable",
    "prefer",
    "require",
    "no-verify",
    "verify-ca",
    "verify-full",
  ]));
  let port = tc.draw(gs::integers::<u16>().min_value(1));

  let db_url = format!("postgres://dbuser:{db_pass}@pg.example.com:6432/nuq?sslmode={sslmode}");
  let rmq_url = format!("amqps://rmquser:{rmq_pass}@mq.example.com:5671/vhost");
  let hb_url = format!("https://heartbeat.example.com/ping/{hb_token}");
  let port_str = port.to_string();

  let pg_settings = parse_pg_connection_settings(&db_url);
  assert!(pg_settings.is_ok());
  if let Ok(settings) = pg_settings {
    let expected_mode = match sslmode {
      "disable" => PgSslMode::Disable,
      "prefer" => PgSslMode::Prefer,
      "require" | "no-verify" => PgSslMode::Require,
      "verify-ca" => PgSslMode::VerifyCa,
      _ => PgSslMode::VerifyFull,
    };
    assert_eq!(settings.ssl_mode(), expected_mode);
    assert_eq!(settings.pg_config().get_application_name(), Some("nuq"));
  }

  let env = HashMap::from([
    ("NUQ_DATABASE_URL", db_url.as_str()),
    ("NUQ_RABBITMQ_URL", rmq_url.as_str()),
    ("NUQ_PREFETCH_WORKER_PORT", port_str.as_str()),
    ("NUQ_PREFETCH_WORKER_HEARTBEAT_URL", hb_url.as_str()),
  ]);

  let cfg = WorkerConfig::from_lookup(|k| env.get(k).map(|v| (*v).to_owned()));
  assert!(cfg.is_ok());
  let Ok(cfg) = cfg else { return };

  let summary = cfg.redacted_summary();
  let debug = format!("{cfg:?}");
  for secret in [&db_pass, &rmq_pass, &hb_token] {
    assert!(!summary.contains(secret.as_str()));
    assert!(!debug.contains(secret.as_str()));
  }
}
