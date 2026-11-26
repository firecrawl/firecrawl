//! NuQ queue definitions, SQL row decoding, wire JSON serialization parity
//! with `rowToJob` / `rabbitRowToJob`, and zero-data-retention (ZDR) detection.

use std::fmt;

use firecrawl_core::telemetry::is_zdr_json_value;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::timestamp::{TimestampError, parse_pg_timestamp_to_iso_utc};

/// Number of columns selected by the NuQ prefetch `RETURNING` clause.
pub const PREFETCH_RETURNING_COLUMNS: usize = 12;

/// The two NuQ PostgreSQL queues serviced by the prefetch worker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum QueueKind {
  Scrape,
  CrawlFinished,
}

impl QueueKind {
  /// Fully qualified PostgreSQL table name (`nuq.queue_*`).
  #[must_use]
  pub const fn table_name(self) -> &'static str {
    match self {
      Self::Scrape => "nuq.queue_scrape",
      Self::CrawlFinished => "nuq.queue_crawl_finished",
    }
  }

  /// Target RabbitMQ prefetch queue name (`<queueName>.prefetch`).
  #[must_use]
  pub const fn prefetch_queue_name(self) -> &'static str {
    match self {
      Self::Scrape => "nuq.queue_scrape.prefetch",
      Self::CrawlFinished => "nuq.queue_crawl_finished.prefetch",
    }
  }

  /// Exact SQL query matching `NuQ::prefetchJobs` in `apps/api/src/services/worker/nuq.ts`.
  #[must_use]
  pub const fn prefetch_sql(self) -> &'static str {
    match self {
      Self::Scrape => {
        "WITH next AS (\
           SELECT id FROM nuq.queue_scrape \
           WHERE nuq.queue_scrape.status = 'queued'::nuq.job_status \
           ORDER BY nuq.queue_scrape.priority ASC, nuq.queue_scrape.created_at ASC \
           FOR UPDATE SKIP LOCKED \
           LIMIT 500\
         ) \
         UPDATE nuq.queue_scrape q \
         SET status = 'active'::nuq.job_status, lock = gen_random_uuid(), locked_at = now() \
         FROM next \
         WHERE q.id = next.id \
         RETURNING q.id, q.status::text, q.created_at, q.priority, q.data, q.finished_at, \
                   q.listen_channel_id, q.returnvalue, q.failedreason, q.lock, q.owner_id, q.group_id;"
      }
      Self::CrawlFinished => {
        "WITH next AS (\
           SELECT id FROM nuq.queue_crawl_finished \
           WHERE nuq.queue_crawl_finished.status = 'queued'::nuq.job_status \
           ORDER BY nuq.queue_crawl_finished.priority ASC, nuq.queue_crawl_finished.created_at ASC \
           FOR UPDATE SKIP LOCKED \
           LIMIT 500\
         ) \
         UPDATE nuq.queue_crawl_finished q \
         SET status = 'active'::nuq.job_status, lock = gen_random_uuid(), locked_at = now() \
         FROM next \
         WHERE q.id = next.id \
         RETURNING q.id, q.status::text, q.created_at, q.priority, q.data, q.finished_at, \
                   q.listen_channel_id, q.returnvalue, q.failedreason, q.lock, q.owner_id, q.group_id;"
      }
    }
  }
}

/// Wire representation of a prefetched NuQ job published to RabbitMQ, matching
/// `JSON.stringify(rowToJob(row))` in `apps/api/src/services/worker/nuq.ts`.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct NuqJob {
  pub id: String,
  pub status: String,
  #[serde(rename = "createdAt")]
  pub created_at: String,
  pub priority: i32,
  pub data: serde_json::Value,
  #[serde(
    rename = "finishedAt",
    default,
    skip_serializing_if = "Option::is_none"
  )]
  pub finished_at: Option<String>,
  #[serde(
    rename = "listenChannelId",
    default,
    skip_serializing_if = "Option::is_none"
  )]
  pub listen_channel_id: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub returnvalue: Option<serde_json::Value>,
  #[serde(
    rename = "failedReason",
    default,
    skip_serializing_if = "Option::is_none"
  )]
  pub failed_reason: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub lock: Option<String>,
  #[serde(rename = "ownerId", default, skip_serializing_if = "Option::is_none")]
  pub owner_id: Option<String>,
  #[serde(rename = "groupId", default, skip_serializing_if = "Option::is_none")]
  pub group_id: Option<String>,
}

// Custom Debug withholds customer payloads (`data`, `returnvalue`, `failed_reason`)
// and also redacts identifiers on ZDR jobs so diagnostic logs never leak ZDR data.
impl fmt::Debug for NuqJob {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    let is_zdr = self.is_zero_data_retention();
    let redacted_str = "[REDACTED]";
    let id_display = if is_zdr {
      redacted_str
    } else {
      self.id.as_str()
    };
    f.debug_struct("NuqJob")
      .field("id", &id_display)
      .field("status", &self.status)
      .field("created_at", &self.created_at)
      .field("priority", &self.priority)
      .field("data", &redacted_str)
      .field("finished_at", &self.finished_at)
      .field(
        "listen_channel_id",
        &self
          .listen_channel_id
          .as_deref()
          .map(|v| if is_zdr { redacted_str } else { v }),
      )
      .field(
        "returnvalue",
        &self.returnvalue.as_ref().map(|_| redacted_str),
      )
      .field(
        "failed_reason",
        &self.failed_reason.as_ref().map(|_| redacted_str),
      )
      .field(
        "lock",
        &self
          .lock
          .as_deref()
          .map(|v| if is_zdr { redacted_str } else { v }),
      )
      .field(
        "owner_id",
        &self
          .owner_id
          .as_deref()
          .map(|v| if is_zdr { redacted_str } else { v }),
      )
      .field(
        "group_id",
        &self
          .group_id
          .as_deref()
          .map(|v| if is_zdr { redacted_str } else { v }),
      )
      .finish()
  }
}

/// Errors returned when decoding a PostgreSQL `SimpleQueryRow` into [`NuqJob`].
#[derive(Debug, Error, PartialEq, Eq)]
pub enum JobDecodeError {
  #[error("expected {PREFETCH_RETURNING_COLUMNS} columns in prefetch row, got {0}")]
  WrongColumnCount(usize),
  #[error("missing required column `{0}`")]
  MissingColumn(&'static str),
  #[error("invalid `priority` integer")]
  InvalidPriority,
  #[error("invalid `{column}` timestamp: {source}")]
  InvalidTimestamp {
    column: &'static str,
    source: TimestampError,
  },
  #[error("invalid `{0}` JSON value")]
  InvalidJson(&'static str),
}

impl NuqJob {
  /// Returns whether this job carries zero-data-retention (ZDR) semantics.
  #[must_use]
  pub fn is_zero_data_retention(&self) -> bool {
    stored_zero_data_retention(Some(&self.data))
  }

  /// Decodes a PostgreSQL `SimpleQueryRow` returned by [`QueueKind::prefetch_sql`].
  pub fn from_pg_row(row: &tokio_postgres::SimpleQueryRow) -> Result<Self, JobDecodeError> {
    if row.len() != PREFETCH_RETURNING_COLUMNS {
      return Err(JobDecodeError::WrongColumnCount(row.len()));
    }
    let cols = [
      row.get(0),
      row.get(1),
      row.get(2),
      row.get(3),
      row.get(4),
      row.get(5),
      row.get(6),
      row.get(7),
      row.get(8),
      row.get(9),
      row.get(10),
      row.get(11),
    ];
    Self::from_pg_columns(&cols)
  }

  /// Decodes the 12 `RETURNING` columns from text values into a [`NuqJob`].
  pub fn from_pg_columns(cols: &[Option<&str>]) -> Result<Self, JobDecodeError> {
    if cols.len() != PREFETCH_RETURNING_COLUMNS {
      return Err(JobDecodeError::WrongColumnCount(cols.len()));
    }

    let id = cols
      .first()
      .and_then(|c| *c)
      .ok_or(JobDecodeError::MissingColumn("id"))?
      .to_owned();
    let status = cols
      .get(1)
      .and_then(|c| *c)
      .ok_or(JobDecodeError::MissingColumn("status"))?
      .to_owned();
    let created_raw = cols
      .get(2)
      .and_then(|c| *c)
      .ok_or(JobDecodeError::MissingColumn("created_at"))?;
    let created_at = parse_pg_timestamp_to_iso_utc(created_raw).map_err(|source| {
      JobDecodeError::InvalidTimestamp {
        column: "created_at",
        source,
      }
    })?;

    let priority_raw = cols
      .get(3)
      .and_then(|c| *c)
      .ok_or(JobDecodeError::MissingColumn("priority"))?;
    let priority = priority_raw
      .parse::<i32>()
      .map_err(|_| JobDecodeError::InvalidPriority)?;

    // In `rowToJob`, `data: row.data` preserves SQL NULL as JSON `null`.
    let data = match cols.get(4).and_then(|c| *c) {
      Some(raw_json) => {
        serde_json::from_str(raw_json).map_err(|_| JobDecodeError::InvalidJson("data"))?
      }
      None => serde_json::Value::Null,
    };

    let finished_at = match cols.get(5).and_then(|c| *c) {
      Some(raw_ts) => Some(parse_pg_timestamp_to_iso_utc(raw_ts).map_err(|source| {
        JobDecodeError::InvalidTimestamp {
          column: "finished_at",
          source,
        }
      })?),
      None => None,
    };

    let listen_channel_id = cols.get(6).and_then(|c| *c).map(str::to_owned);

    // In `rowToJob`, `returnvalue: row.returnvalue ?? undefined` turns both SQL
    // NULL and JSONB `null` into omitted (`None`).
    let returnvalue = match cols.get(7).and_then(|c| *c) {
      Some(raw_json) => {
        let parsed: serde_json::Value =
          serde_json::from_str(raw_json).map_err(|_| JobDecodeError::InvalidJson("returnvalue"))?;
        if parsed.is_null() { None } else { Some(parsed) }
      }
      None => None,
    };

    let failed_reason = cols.get(8).and_then(|c| *c).map(str::to_owned);
    let lock = cols.get(9).and_then(|c| *c).map(str::to_owned);
    let owner_id = cols.get(10).and_then(|c| *c).map(str::to_owned);
    let group_id = cols.get(11).and_then(|c| *c).map(str::to_owned);

    Ok(Self {
      id,
      status,
      created_at,
      priority,
      data,
      finished_at,
      listen_channel_id,
      returnvalue,
      failed_reason,
      lock,
      owner_id,
      group_id,
    })
  }
}

fn read_zdr_field(map: &serde_json::Map<String, serde_json::Value>) -> Option<bool> {
  let camel = map.get("zeroDataRetention").filter(|v| !v.is_null());
  let snake = map.get("zero_data_retention").filter(|v| !v.is_null());
  match (camel, snake) {
    (Some(c), Some(s)) => Some(is_zdr_json_value(Some(c)) || is_zdr_json_value(Some(s))),
    (Some(v), None) | (None, Some(v)) => Some(is_zdr_json_value(Some(v))),
    (None, None) => None,
  }
}

/// Detects zero-data-retention (ZDR) on a stored NuQ job payload, matching
/// `storedZeroDataRetention` in `apps/api/src/lib/request-context.ts` while
/// failing closed on any non-null, non-`false` value.
#[must_use]
pub fn stored_zero_data_retention(data: Option<&serde_json::Value>) -> bool {
  let Some(serde_json::Value::Object(map)) = data else {
    return false;
  };
  if let Some(ctx_map) = map.get("ctx").and_then(serde_json::Value::as_object)
    && let Some(flag) = read_zdr_field(ctx_map)
  {
    return flag;
  }
  read_zdr_field(map).unwrap_or(false)
}

#[cfg(test)]
mod tests {
  use serde_json::json;

  use super::*;

  #[test]
  fn decodes_full_and_sparse_pg_rows_with_exact_wire_json() {
    let full_cols = [
      Some("550e8400-e29b-41d4-a716-446655440000"),
      Some("active"),
      Some("2026-11-26 02:00:00.123999+00"),
      Some("10"),
      Some(r#"{"url":"https://example.com","ctx":{"zeroDataRetention":true}}"#),
      Some("2026-11-26 02:01:00.5+00"),
      Some("main-chan"),
      Some(r#"{"ok":true}"#),
      Some("none"),
      Some("660e8400-e29b-41d4-a716-446655440000"),
      Some("770e8400-e29b-41d4-a716-446655440000"),
      Some("880e8400-e29b-41d4-a716-446655440000"),
    ];
    let job = NuqJob::from_pg_columns(&full_cols);
    assert!(job.is_ok());
    let Ok(job) = job else { return };
    assert!(job.is_zero_data_retention());

    let debug_str = format!("{job:?}");
    assert!(!debug_str.contains("https://example.com"));
    assert!(!debug_str.contains("none"));
    assert!(!debug_str.contains("550e8400-e29b-41d4-a716-446655440000"));
    assert!(!debug_str.contains("660e8400-e29b-41d4-a716-446655440000"));
    assert!(!debug_str.contains("770e8400-e29b-41d4-a716-446655440000"));
    assert!(!debug_str.contains("880e8400-e29b-41d4-a716-446655440000"));

    let wire = serde_json::to_value(&job);
    assert!(wire.is_ok());
    assert_eq!(
      wire.ok(),
      Some(json!({
        "id": "550e8400-e29b-41d4-a716-446655440000",
        "status": "active",
        "createdAt": "2026-11-26T02:00:00.123Z",
        "priority": 10,
        "data": {"url": "https://example.com", "ctx": {"zeroDataRetention": true}},
        "finishedAt": "2026-11-26T02:01:00.500Z",
        "listenChannelId": "main-chan",
        "returnvalue": {"ok": true},
        "failedReason": "none",
        "lock": "660e8400-e29b-41d4-a716-446655440000",
        "ownerId": "770e8400-e29b-41d4-a716-446655440000",
        "groupId": "880e8400-e29b-41d4-a716-446655440000"
      }))
    );

    let sparse_cols = [
      Some("550e8400-e29b-41d4-a716-446655440001"),
      Some("active"),
      Some("2026-11-26 02:00:00+00"),
      Some("0"),
      None,
      None,
      None,
      Some("null"),
      None,
      Some("660e8400-e29b-41d4-a716-446655440001"),
      None,
      None,
    ];
    let sparse = NuqJob::from_pg_columns(&sparse_cols);
    assert!(sparse.is_ok());
    let Ok(sparse) = sparse else { return };
    assert!(!sparse.is_zero_data_retention());
    let sparse_json = serde_json::to_string(&sparse);
    assert!(sparse_json.is_ok());
    assert_eq!(
      sparse_json.ok(),
      Some(
        r#"{"id":"550e8400-e29b-41d4-a716-446655440001","status":"active","createdAt":"2026-11-26T02:00:00.000Z","priority":0,"data":null,"lock":"660e8400-e29b-41d4-a716-446655440001"}"#
          .to_owned()
      )
    );
  }

  #[test]
  fn stored_zdr_matches_request_context_semantics() {
    assert!(!stored_zero_data_retention(None));
    assert!(!stored_zero_data_retention(Some(&json!(null))));
    assert!(!stored_zero_data_retention(Some(&json!({}))));
    assert!(stored_zero_data_retention(Some(
      &json!({"zeroDataRetention": true})
    )));
    assert!(!stored_zero_data_retention(Some(
      &json!({"zeroDataRetention": false})
    )));
    assert!(stored_zero_data_retention(Some(
      &json!({"ctx": {"zeroDataRetention": true}})
    )));
    assert!(!stored_zero_data_retention(Some(
      &json!({"ctx": {"zeroDataRetention": false}, "zeroDataRetention": true})
    )));
    assert!(stored_zero_data_retention(Some(
      &json!({"ctx": {"zeroDataRetention": null}, "zeroDataRetention": true})
    )));
    assert!(stored_zero_data_retention(Some(
      &json!({"ctx": {"zeroDataRetention": "yes"}})
    )));
    assert!(stored_zero_data_retention(Some(
      &json!({"zero_data_retention": true})
    )));
  }
}
