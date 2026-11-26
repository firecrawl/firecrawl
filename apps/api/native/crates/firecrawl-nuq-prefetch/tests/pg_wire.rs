//! Wire-level PostgreSQL v3 integration test proving `PgStore` sends
//! `application_name=nuq`, uses ONLY Simple Query Protocol (`'Q'`) with zero
//! named prepared statements (`'P'`) for PgBouncer transaction-mode safety,
//! decodes all 12 `RETURNING` columns cleanly, and reports accurate pool metrics.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use firecrawl_nuq_prefetch::{
  FailedJobNotification, PgStore, QueueKind, StoreError, parse_pg_connection_settings,
};

#[derive(Debug, Default)]
struct CapturedPgWire {
  application_name: Option<String>,
  queries: Vec<String>,
  saw_parse_message: bool,
  failed_row_updates_handled: usize,
}

struct MockPgControls {
  fail_repair_remaining: AtomicUsize,
}

fn push_error_response_and_ready(buf: &mut Vec<u8>, message: &str) {
  let mut err_body = Vec::new();
  err_body.push(b'S');
  err_body.extend_from_slice(b"ERROR\0");
  err_body.push(b'C');
  err_body.extend_from_slice(b"XX000\0");
  err_body.push(b'M');
  err_body.extend_from_slice(message.as_bytes());
  err_body.push(0);
  err_body.push(0);
  buf.push(b'E');
  let len = i32::try_from(err_body.len().saturating_add(4)).unwrap_or(4);
  buf.extend_from_slice(&len.to_be_bytes());
  buf.extend_from_slice(&err_body);
  buf.push(b'Z');
  buf.extend_from_slice(&5_i32.to_be_bytes());
  buf.push(b'I');
}

async fn write_auth_ok_and_ready(stream: &mut TcpStream) -> std::io::Result<()> {
  // AuthenticationOk ('R', len=8, code=0)
  let mut buf = Vec::new();
  buf.push(b'R');
  buf.extend_from_slice(&8_i32.to_be_bytes());
  buf.extend_from_slice(&0_i32.to_be_bytes());
  // ReadyForQuery ('Z', len=5, status='I')
  buf.push(b'Z');
  buf.extend_from_slice(&5_i32.to_be_bytes());
  buf.push(b'I');
  stream.write_all(&buf).await
}

fn push_row_description(buf: &mut Vec<u8>, columns: &[&str]) {
  let mut body = Vec::new();
  let count = i16::try_from(columns.len()).unwrap_or(0);
  body.extend_from_slice(&count.to_be_bytes());
  for col in columns {
    body.extend_from_slice(col.as_bytes());
    body.push(0);
    body.extend_from_slice(&0_i32.to_be_bytes()); // table oid
    body.extend_from_slice(&0_i16.to_be_bytes()); // col attr
    body.extend_from_slice(&25_i32.to_be_bytes()); // TEXT oid
    body.extend_from_slice(&(-1_i16).to_be_bytes()); // type size
    body.extend_from_slice(&(-1_i32).to_be_bytes()); // type mod
    body.extend_from_slice(&0_i16.to_be_bytes()); // text format
  }
  buf.push(b'T');
  let len = i32::try_from(body.len().saturating_add(4)).unwrap_or(4);
  buf.extend_from_slice(&len.to_be_bytes());
  buf.extend_from_slice(&body);
}

fn push_data_row(buf: &mut Vec<u8>, values: &[Option<&str>]) {
  let mut body = Vec::new();
  let count = i16::try_from(values.len()).unwrap_or(0);
  body.extend_from_slice(&count.to_be_bytes());
  for val in values {
    match val {
      Some(s) => {
        let vlen = i32::try_from(s.len()).unwrap_or(0);
        body.extend_from_slice(&vlen.to_be_bytes());
        body.extend_from_slice(s.as_bytes());
      }
      None => {
        body.extend_from_slice(&(-1_i32).to_be_bytes());
      }
    }
  }
  buf.push(b'D');
  let len = i32::try_from(body.len().saturating_add(4)).unwrap_or(4);
  buf.extend_from_slice(&len.to_be_bytes());
  buf.extend_from_slice(&body);
}

fn push_command_complete_and_ready(buf: &mut Vec<u8>, tag: &str) {
  buf.push(b'C');
  let clen = i32::try_from(tag.len().saturating_add(5)).unwrap_or(5);
  buf.extend_from_slice(&clen.to_be_bytes());
  buf.extend_from_slice(tag.as_bytes());
  buf.push(0);

  buf.push(b'Z');
  buf.extend_from_slice(&5_i32.to_be_bytes());
  buf.push(b'I');
}

async fn serve_mock_pg_connection(
  mut stream: TcpStream,
  state: Arc<Mutex<CapturedPgWire>>,
  controls: Arc<MockPgControls>,
) {
  let Ok(len) = stream.read_i32().await else {
    return;
  };
  let Ok(body_len) = usize::try_from(len.saturating_sub(4)) else {
    return;
  };
  let mut startup = vec![0_u8; body_len];
  if stream.read_exact(&mut startup).await.is_err() {
    return;
  }

  // Parse StartupMessage key/value pairs after the 4-byte protocol version.
  if let Some(params) = startup.get(4..) {
    let parts: Vec<&[u8]> = params.split(|b| *b == 0).collect();
    let mut idx = 0_usize;
    while let (Some(k), Some(v)) = (parts.get(idx), parts.get(idx.saturating_add(1))) {
      if k.is_empty() {
        break;
      }
      if *k == b"application_name"
        && let Ok(name) = std::str::from_utf8(v)
      {
        state
          .lock()
          .unwrap_or_else(PoisonError::into_inner)
          .application_name = Some(name.to_owned());
      }
      idx = idx.saturating_add(2);
    }
  }

  if write_auth_ok_and_ready(&mut stream).await.is_err() {
    return;
  }

  loop {
    let mut tag = [0_u8; 1];
    if stream.read_exact(&mut tag).await.is_err() {
      break;
    }
    let Ok(msg_len) = stream.read_i32().await else {
      break;
    };
    let Ok(payload_len) = usize::try_from(msg_len.saturating_sub(4)) else {
      break;
    };
    let mut payload = vec![0_u8; payload_len];
    if stream.read_exact(&mut payload).await.is_err() {
      break;
    }

    match tag {
      [b'X'] => break,
      [b'P'] => {
        state
          .lock()
          .unwrap_or_else(PoisonError::into_inner)
          .saw_parse_message = true;
        break;
      }
      [b'Q'] => {
        let sql = std::str::from_utf8(payload.strip_suffix(&[0]).unwrap_or(&payload))
          .unwrap_or("")
          .to_owned();
        state
          .lock()
          .unwrap_or_else(PoisonError::into_inner)
          .queries
          .push(sql.clone());

        let mut resp = Vec::new();
        if sql.trim() == "SELECT 1;" {
          push_row_description(&mut resp, &["?column?"]);
          push_data_row(&mut resp, &[Some("1")]);
          push_command_complete_and_ready(&mut resp, "SELECT 1");
        } else if sql.contains("SET status = 'failed'::nuq.job_status") {
          let mut guard = state.lock().unwrap_or_else(PoisonError::into_inner);
          guard.failed_row_updates_handled = guard.failed_row_updates_handled.saturating_add(1);
          drop(guard);
          let should_error = controls
            .fail_repair_remaining
            .try_update(Ordering::AcqRel, Ordering::Acquire, |n| n.checked_sub(1))
            .is_ok();
          if should_error {
            push_error_response_and_ready(&mut resp, "simulated repair update failure");
          } else {
            push_row_description(&mut resp, &["id", "listen_channel_id", "pg_notify"]);
            push_data_row(
              &mut resp,
              &[
                Some("00000000-0000-0000-0000-000000000000"),
                Some("waiter-channel-9"),
                Some(""),
              ],
            );
            push_command_complete_and_ready(&mut resp, "SELECT 1");
          }
        } else if sql.starts_with("WITH next AS") && sql.contains("nuq.queue_scrape") {
          push_row_description(
            &mut resp,
            &[
              "id",
              "status",
              "created_at",
              "priority",
              "data",
              "finished_at",
              "listen_channel_id",
              "returnvalue",
              "failedreason",
              "lock",
              "owner_id",
              "group_id",
            ],
          );
          push_data_row(
            &mut resp,
            &[
              Some("00000000-0000-0000-0000-000000000000"),
              Some("active"),
              Some("not-a-valid-timestamp"),
              Some("0"),
              None,
              None,
              Some("waiter-channel-9"),
              None,
              None,
              Some("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
              None,
              None,
            ],
          );
          push_data_row(
            &mut resp,
            &[
              Some("11111111-1111-1111-1111-111111111111"),
              Some("active"),
              Some("2026-11-26 02:00:00.987654+00"),
              Some("5"),
              Some(r#"{"url":"https://example.com","ctx":{"zeroDataRetention":true}}"#),
              None,
              Some("main-listener"),
              None,
              None,
              Some("22222222-2222-2222-2222-222222222222"),
              Some("33333333-3333-3333-3333-333333333333"),
              None,
            ],
          );
          push_command_complete_and_ready(&mut resp, "UPDATE 2");
        } else {
          push_row_description(
            &mut resp,
            &[
              "id",
              "status",
              "created_at",
              "priority",
              "data",
              "finished_at",
              "listen_channel_id",
              "returnvalue",
              "failedreason",
              "lock",
              "owner_id",
              "group_id",
            ],
          );
          push_command_complete_and_ready(&mut resp, "UPDATE 0");
        }

        if stream.write_all(&resp).await.is_err() {
          break;
        }
      }
      _ => break,
    }
  }
}

#[tokio::test]
async fn pg_store_uses_application_name_nuq_and_simple_query_only_for_pgbouncer_safety() {
  let listener = TcpListener::bind("127.0.0.1:0").await;
  assert!(listener.is_ok());
  let Ok(listener) = listener else { return };
  let addr = listener.local_addr();
  assert!(addr.is_ok());
  let Ok(addr) = addr else { return };

  let captured = Arc::new(Mutex::new(CapturedPgWire::default()));
  let controls = Arc::new(MockPgControls {
    fail_repair_remaining: AtomicUsize::new(0),
  });
  let server_state = Arc::clone(&captured);
  let server_controls = Arc::clone(&controls);
  let server = tokio::spawn(async move {
    while let Ok((stream, _)) = listener.accept().await {
      let conn_state = Arc::clone(&server_state);
      let conn_controls = Arc::clone(&server_controls);
      tokio::spawn(serve_mock_pg_connection(stream, conn_state, conn_controls));
    }
  });

  let url = format!("postgres://postgres:secret@{addr}/nuq?sslmode=disable");
  let settings = parse_pg_connection_settings(&url);
  assert!(settings.is_ok());
  let Ok(settings) = settings else { return };

  let store = PgStore::new(&settings);
  assert!(store.is_ok());
  let Ok(store) = store else { return };

  assert_eq!(store.health_check().await.ok(), Some(true));

  let scrape_batch = store.prefetch_jobs(QueueKind::Scrape).await;
  assert!(scrape_batch.is_ok(), "prefetch failed: {scrape_batch:?}");
  let Ok(scrape_batch) = scrape_batch else {
    return;
  };
  assert!(scrape_batch.repair_error.is_none());
  assert_eq!(
    scrape_batch.failed_notifications,
    vec![FailedJobNotification {
      id: "00000000-0000-0000-0000-000000000000".to_owned(),
      listen_channel_id: Some("waiter-channel-9".to_owned()),
    }]
  );
  assert_eq!(scrape_batch.jobs.len(), 1);
  if let Some(job) = scrape_batch.jobs.first() {
    assert_eq!(job.id, "11111111-1111-1111-1111-111111111111");
    assert_eq!(job.status, "active");
    assert_eq!(job.created_at, "2026-11-26T02:00:00.987Z");
    assert_eq!(job.priority, 5);
    assert!(job.is_zero_data_retention());
    assert_eq!(
      job.data,
      json!({"url": "https://example.com", "ctx": {"zeroDataRetention": true}})
    );
    assert_eq!(job.listen_channel_id.as_deref(), Some("main-listener"));
    assert_eq!(
      job.lock.as_deref(),
      Some("22222222-2222-2222-2222-222222222222")
    );
    assert_eq!(
      job.owner_id.as_deref(),
      Some("33333333-3333-3333-3333-333333333333")
    );
    assert!(job.group_id.is_none());
    assert!(job.finished_at.is_none());
    assert!(job.returnvalue.is_none());
    assert!(job.failed_reason.is_none());
  }

  let crawl_batch = store.prefetch_jobs(QueueKind::CrawlFinished).await;
  assert!(crawl_batch.is_ok());
  assert_eq!(crawl_batch.ok().map(|b| b.jobs.len()), Some(0));

  let metrics = store.pool_metrics();
  assert!(metrics.total_count >= 1);
  assert!(metrics.idle_count >= 1);
  assert_eq!(metrics.waiting_count, 0);

  store.close();
  server.abort();

  let wire = captured.lock().unwrap_or_else(PoisonError::into_inner);
  assert_eq!(wire.application_name.as_deref(), Some("nuq"));
  assert!(
    !wire.saw_parse_message,
    "PgBouncer transaction mode violated: saw extended query Parse message"
  );
  assert_eq!(wire.failed_row_updates_handled, 1);
  assert_eq!(wire.queries.len(), 4);
  assert_eq!(wire.queries.first().map(String::as_str), Some("SELECT 1;"));
  assert_eq!(
    wire.queries.get(1).map(String::as_str),
    Some(QueueKind::Scrape.prefetch_sql())
  );
  assert_eq!(
    wire.queries.get(2).map(String::as_str),
    Some(
      "WITH updated AS (UPDATE nuq.queue_scrape SET status = 'failed'::nuq.job_status, lock = null, locked_at = null, finished_at = now(), failedreason = 'Failed to decode prefetched NuQ job row' WHERE id = '00000000-0000-0000-0000-000000000000'::uuid AND lock = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid RETURNING id, listen_channel_id), target AS (SELECT id, listen_channel_id FROM updated UNION ALL SELECT id, listen_channel_id FROM nuq.queue_scrape WHERE NOT EXISTS (SELECT 1 FROM updated) AND id = '00000000-0000-0000-0000-000000000000'::uuid AND status = 'failed'::nuq.job_status AND failedreason = 'Failed to decode prefetched NuQ job row') SELECT t.id, t.listen_channel_id, pg_notify('nuq.queue_scrape', t.id::text || '|failed') FROM target t;"
    )
  );
  assert_eq!(
    wire.queries.get(3).map(String::as_str),
    Some(QueueKind::CrawlFinished.prefetch_sql())
  );
}

#[tokio::test]
async fn pg_store_retries_and_propagates_decode_repair_failure_without_dropping_valid_jobs() {
  let listener = TcpListener::bind("127.0.0.1:0").await;
  assert!(listener.is_ok());
  let Ok(listener) = listener else { return };
  let addr = listener.local_addr();
  assert!(addr.is_ok());
  let Ok(addr) = addr else { return };

  let captured = Arc::new(Mutex::new(CapturedPgWire::default()));
  let controls = Arc::new(MockPgControls {
    fail_repair_remaining: AtomicUsize::new(2),
  });
  let server_state = Arc::clone(&captured);
  let server_controls = Arc::clone(&controls);
  let server = tokio::spawn(async move {
    while let Ok((stream, _)) = listener.accept().await {
      let conn_state = Arc::clone(&server_state);
      let conn_controls = Arc::clone(&server_controls);
      tokio::spawn(serve_mock_pg_connection(stream, conn_state, conn_controls));
    }
  });

  let url = format!("postgres://postgres:secret@{addr}/nuq?sslmode=disable");
  let settings = parse_pg_connection_settings(&url);
  assert!(settings.is_ok());
  let Ok(settings) = settings else { return };
  let store = PgStore::new(&settings);
  assert!(store.is_ok());
  let Ok(store) = store else { return };

  let batch = store.prefetch_jobs(QueueKind::Scrape).await;
  assert!(batch.is_ok());
  let Ok(batch) = batch else { return };
  assert_eq!(batch.jobs.len(), 1);
  assert!(batch.failed_notifications.is_empty());
  assert!(matches!(batch.repair_error, Some(StoreError::Query(_))));

  store.close();
  server.abort();

  let wire = captured.lock().unwrap_or_else(PoisonError::into_inner);
  // 1 initial attempt + 1 retry on repair UPDATE failure.
  assert_eq!(wire.failed_row_updates_handled, 2);
  assert_eq!(controls.fail_repair_remaining.load(Ordering::Acquire), 0);
}
