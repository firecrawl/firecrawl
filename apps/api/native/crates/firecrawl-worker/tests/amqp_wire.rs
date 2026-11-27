//! Wire-level AMQP 0-9-1 integration test proving `AmqpPrefetchPublisher`
//! declares `<queue>.prefetch` as a durable quorum queue with `x-max-length=20000`,
//! publishes exact `correlation_id`, `delivery_mode=2`, `expiration="50000"`, and
//! JSON payload bytes, reconnects cleanly after a broker drop, and handles unset
//! `NUQ_RABBITMQ_URL` without crashing.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;

use firecrawl_worker::nuq_prefetch::{
  AmqpPrefetchPublisher, NuqJob, PublishError, QueueKind, RedactedString,
};

#[derive(Debug, Default)]
struct CapturedQueueDeclare {
  queue: String,
  durable: bool,
  queue_type: Option<String>,
  max_length: Option<i64>,
}

#[derive(Debug, Default)]
struct CapturedPublish {
  exchange: String,
  routing_key: String,
  delivery_mode: Option<u8>,
  correlation_id: Option<String>,
  expiration: Option<String>,
  body: Vec<u8>,
}

#[derive(Debug, Default)]
struct CapturedAmqpWire {
  connections: usize,
  declares: Vec<CapturedQueueDeclare>,
  confirm_selects: usize,
  received_publishes: usize,
  publishes: Vec<CapturedPublish>,
  channel_closes: usize,
  connection_closes: usize,
}

async fn write_frame(
  stream: &mut TcpStream,
  frame_type: u8,
  channel: u16,
  payload: &[u8],
) -> std::io::Result<()> {
  let mut buf = Vec::with_capacity(payload.len().saturating_add(8));
  buf.push(frame_type);
  buf.extend_from_slice(&channel.to_be_bytes());
  let size = u32::try_from(payload.len()).unwrap_or(0);
  buf.extend_from_slice(&size.to_be_bytes());
  buf.extend_from_slice(payload);
  buf.push(0xCE);
  stream.write_all(&buf).await
}

async fn read_frame(stream: &mut TcpStream) -> std::io::Result<(u8, u16, Vec<u8>)> {
  let mut header = [0_u8; 7];
  stream.read_exact(&mut header).await?;
  let [frame_type, ch0, ch1, sz0, sz1, sz2, sz3] = header;
  let channel = u16::from_be_bytes([ch0, ch1]);
  let size = u32::from_be_bytes([sz0, sz1, sz2, sz3]);
  let len = usize::try_from(size).unwrap_or(0);
  let mut payload = vec![0_u8; len];
  stream.read_exact(&mut payload).await?;
  let mut end = [0_u8; 1];
  stream.read_exact(&mut end).await?;
  Ok((frame_type, channel, payload))
}

fn push_short_str(buf: &mut Vec<u8>, s: &str) {
  buf.push(u8::try_from(s.len()).unwrap_or(0));
  buf.extend_from_slice(s.as_bytes());
}

fn push_long_str(buf: &mut Vec<u8>, s: &str) {
  let len = u32::try_from(s.len()).unwrap_or(0);
  buf.extend_from_slice(&len.to_be_bytes());
  buf.extend_from_slice(s.as_bytes());
}

fn read_short_str<'a>(data: &'a [u8], pos: &mut usize) -> Option<&'a str> {
  let len = usize::from(*data.get(*pos)?);
  *pos = pos.checked_add(1)?;
  let end = pos.checked_add(len)?;
  let slice = data.get(*pos..end)?;
  *pos = end;
  std::str::from_utf8(slice).ok()
}

fn read_long_str<'a>(data: &'a [u8], pos: &mut usize) -> Option<&'a str> {
  let end_len = pos.checked_add(4)?;
  let len_bytes: [u8; 4] = data.get(*pos..end_len)?.try_into().ok()?;
  *pos = end_len;
  let len = usize::try_from(u32::from_be_bytes(len_bytes)).ok()?;
  let end = pos.checked_add(len)?;
  let slice = data.get(*pos..end)?;
  *pos = end;
  std::str::from_utf8(slice).ok()
}

fn parse_field_table(data: &[u8], pos: &mut usize) -> HashMap<String, (u8, String)> {
  let mut map = HashMap::new();
  let Some(end_len) = pos.checked_add(4) else {
    return map;
  };
  let Some(len_slice) = data.get(*pos..end_len) else {
    return map;
  };
  let Ok(len_arr): Result<[u8; 4], _> = len_slice.try_into() else {
    return map;
  };
  *pos = end_len;
  let table_len = usize::try_from(u32::from_be_bytes(len_arr)).unwrap_or(0);
  let table_end = pos.saturating_add(table_len);

  while *pos < table_end {
    let Some(key) = read_short_str(data, pos).map(str::to_owned) else {
      break;
    };
    let Some(&kind) = data.get(*pos) else {
      break;
    };
    *pos = pos.saturating_add(1);
    match kind {
      b'S' => {
        if let Some(val) = read_long_str(data, pos) {
          map.insert(key, (kind, val.to_owned()));
        }
      }
      b'I' => {
        if let Some(end) = pos.checked_add(4)
          && let Some(slice) = data.get(*pos..end)
          && let Ok(arr) = <[u8; 4]>::try_from(slice)
        {
          *pos = end;
          map.insert(key, (kind, i32::from_be_bytes(arr).to_string()));
        }
      }
      b'l' => {
        if let Some(end) = pos.checked_add(8)
          && let Some(slice) = data.get(*pos..end)
          && let Ok(arr) = <[u8; 8]>::try_from(slice)
        {
          *pos = end;
          map.insert(key, (kind, i64::from_be_bytes(arr).to_string()));
        }
      }
      _ => break,
    }
  }
  map
}

fn parse_basic_properties(header_payload: &[u8]) -> (Option<u8>, Option<String>, Option<String>) {
  // Content header: class_id (2), weight (2), body_size (8), property_flags (2)
  let Some(flag_slice) = header_payload.get(12..14) else {
    return (None, None, None);
  };
  let Ok(flag_arr): Result<[u8; 2], _> = flag_slice.try_into() else {
    return (None, None, None);
  };
  let flags = u16::from_be_bytes(flag_arr);
  let mut pos = 14_usize;

  // AMQP 0-9-1 Basic property bits (MSB first):
  // 15: content-type, 14: content-encoding, 13: headers, 12: delivery-mode,
  // 11: priority, 10: correlation-id, 9: reply-to, 8: expiration
  if flags & (1 << 15) != 0 {
    let _ = read_short_str(header_payload, &mut pos);
  }
  if flags & (1 << 14) != 0 {
    let _ = read_short_str(header_payload, &mut pos);
  }
  if flags & (1 << 13) != 0 {
    let _ = parse_field_table(header_payload, &mut pos);
  }
  let delivery_mode = if flags & (1 << 12) != 0 {
    let v = header_payload.get(pos).copied();
    pos = pos.saturating_add(1);
    v
  } else {
    None
  };
  if flags & (1 << 11) != 0 {
    pos = pos.saturating_add(1);
  }
  let correlation_id = if flags & (1 << 10) != 0 {
    read_short_str(header_payload, &mut pos).map(str::to_owned)
  } else {
    None
  };
  if flags & (1 << 9) != 0 {
    let _ = read_short_str(header_payload, &mut pos);
  }
  let expiration = if flags & (1 << 8) != 0 {
    read_short_str(header_payload, &mut pos).map(str::to_owned)
  } else {
    None
  };

  (delivery_mode, correlation_id, expiration)
}

struct MockBrokerControls {
  drop_after_publish: AtomicUsize,
  drop_before_confirm_budget: AtomicUsize,
  nack_budget: AtomicUsize,
  withhold_confirm_budget: AtomicUsize,
  dropped_notify: Notify,
}

async fn serve_mock_amqp_connection(
  mut stream: TcpStream,
  state: Arc<Mutex<CapturedAmqpWire>>,
  controls: Arc<MockBrokerControls>,
) {
  let mut proto = [0_u8; 8];
  if stream.read_exact(&mut proto).await.is_err() || &proto != b"AMQP\x00\x00\x09\x01" {
    return;
  }

  {
    let mut guard = state.lock().unwrap_or_else(PoisonError::into_inner);
    guard.connections = guard.connections.saturating_add(1);
  }

  // Send Connection.Start (class 10, method 10)
  let mut start = Vec::new();
  start.extend_from_slice(&10_u16.to_be_bytes());
  start.extend_from_slice(&10_u16.to_be_bytes());
  start.push(0); // version-major
  start.push(9); // version-minor
  start.extend_from_slice(&0_u32.to_be_bytes()); // empty server-properties table
  push_long_str(&mut start, "PLAIN");
  push_long_str(&mut start, "en_US");
  if write_frame(&mut stream, 1, 0, &start).await.is_err() {
    return;
  }

  // Expect Connection.StartOk
  if read_frame(&mut stream).await.is_err() {
    return;
  }

  // Send Connection.Tune (class 10, method 30)
  let mut tune = Vec::new();
  tune.extend_from_slice(&10_u16.to_be_bytes());
  tune.extend_from_slice(&30_u16.to_be_bytes());
  tune.extend_from_slice(&2047_u16.to_be_bytes()); // channel-max
  tune.extend_from_slice(&131_072_u32.to_be_bytes()); // frame-max
  tune.extend_from_slice(&0_u16.to_be_bytes()); // heartbeat disabled in mock
  if write_frame(&mut stream, 1, 0, &tune).await.is_err() {
    return;
  }

  // Expect Connection.TuneOk + Connection.Open
  if read_frame(&mut stream).await.is_err() {
    return;
  }
  if read_frame(&mut stream).await.is_err() {
    return;
  }

  // Send Connection.OpenOk (class 10, method 41)
  let mut open_ok = Vec::new();
  open_ok.extend_from_slice(&10_u16.to_be_bytes());
  open_ok.extend_from_slice(&41_u16.to_be_bytes());
  push_short_str(&mut open_ok, "");
  if write_frame(&mut stream, 1, 0, &open_ok).await.is_err() {
    return;
  }

  let mut pending_publish: Option<CapturedPublish> = None;
  let mut delivery_tag: u64 = 0;

  while let Ok((frame_type, channel, payload)) = read_frame(&mut stream).await {
    match frame_type {
      1 => {
        let Some(class_bytes) = payload.get(0..2) else {
          break;
        };
        let Some(method_bytes) = payload.get(2..4) else {
          break;
        };
        let Ok(c_arr): Result<[u8; 2], _> = class_bytes.try_into() else {
          break;
        };
        let Ok(m_arr): Result<[u8; 2], _> = method_bytes.try_into() else {
          break;
        };
        let class_id = u16::from_be_bytes(c_arr);
        let method_id = u16::from_be_bytes(m_arr);

        match (class_id, method_id) {
          (20, 10) => {
            // Channel.Open -> Channel.OpenOk (20, 11)
            let mut resp = Vec::new();
            resp.extend_from_slice(&20_u16.to_be_bytes());
            resp.extend_from_slice(&11_u16.to_be_bytes());
            push_long_str(&mut resp, "");
            if write_frame(&mut stream, 1, channel, &resp).await.is_err() {
              break;
            }
          }
          (85, 10) => {
            // Confirm.Select -> Confirm.SelectOk (85, 11)
            {
              let mut guard = state.lock().unwrap_or_else(PoisonError::into_inner);
              guard.confirm_selects = guard.confirm_selects.saturating_add(1);
            }
            let mut resp = Vec::new();
            resp.extend_from_slice(&85_u16.to_be_bytes());
            resp.extend_from_slice(&11_u16.to_be_bytes());
            if write_frame(&mut stream, 1, channel, &resp).await.is_err() {
              break;
            }
          }
          (50, 10) => {
            // Queue.Declare: ticket (2), queue (shortstr), bits (1), args (table)
            let mut pos = 6_usize;
            let queue = read_short_str(&payload, &mut pos).unwrap_or("").to_owned();
            let bits = payload.get(pos).copied().unwrap_or(0);
            pos = pos.saturating_add(1);
            let durable = (bits & 0x02) != 0;
            let args = parse_field_table(&payload, &mut pos);

            let queue_type = args.get("x-queue-type").map(|(_, v)| v.clone());
            let max_length = args
              .get("x-max-length")
              .and_then(|(_, v)| v.parse::<i64>().ok());

            state
              .lock()
              .unwrap_or_else(PoisonError::into_inner)
              .declares
              .push(CapturedQueueDeclare {
                queue: queue.clone(),
                durable,
                queue_type,
                max_length,
              });

            // Queue.DeclareOk (50, 11)
            let mut resp = Vec::new();
            resp.extend_from_slice(&50_u16.to_be_bytes());
            resp.extend_from_slice(&11_u16.to_be_bytes());
            push_short_str(&mut resp, &queue);
            resp.extend_from_slice(&0_u32.to_be_bytes());
            resp.extend_from_slice(&0_u32.to_be_bytes());
            if write_frame(&mut stream, 1, channel, &resp).await.is_err() {
              break;
            }
          }
          (60, 40) => {
            // Basic.Publish: ticket (2), exchange (shortstr), routing_key (shortstr), bits (1)
            let mut pos = 6_usize;
            let exchange = read_short_str(&payload, &mut pos).unwrap_or("").to_owned();
            let routing_key = read_short_str(&payload, &mut pos).unwrap_or("").to_owned();
            pending_publish = Some(CapturedPublish {
              exchange,
              routing_key,
              ..CapturedPublish::default()
            });
          }
          (20, 40) => {
            {
              let mut guard = state.lock().unwrap_or_else(PoisonError::into_inner);
              guard.channel_closes = guard.channel_closes.saturating_add(1);
            }
            let mut resp = Vec::new();
            resp.extend_from_slice(&20_u16.to_be_bytes());
            resp.extend_from_slice(&41_u16.to_be_bytes());
            let _ = write_frame(&mut stream, 1, channel, &resp).await;
          }
          (10, 50) => {
            {
              let mut guard = state.lock().unwrap_or_else(PoisonError::into_inner);
              guard.connection_closes = guard.connection_closes.saturating_add(1);
            }
            let mut resp = Vec::new();
            resp.extend_from_slice(&10_u16.to_be_bytes());
            resp.extend_from_slice(&51_u16.to_be_bytes());
            let _ = write_frame(&mut stream, 1, 0, &resp).await;
            break;
          }
          _ => {}
        }
      }
      2 => {
        if let Some(pub_msg) = pending_publish.as_mut() {
          let (delivery_mode, correlation_id, expiration) = parse_basic_properties(&payload);
          pub_msg.delivery_mode = delivery_mode;
          pub_msg.correlation_id = correlation_id;
          pub_msg.expiration = expiration;
        }
      }
      3 => {
        if let Some(mut pub_msg) = pending_publish.take() {
          delivery_tag = delivery_tag.saturating_add(1);
          pub_msg.body = payload;
          {
            let mut guard = state.lock().unwrap_or_else(PoisonError::into_inner);
            guard.received_publishes = guard.received_publishes.saturating_add(1);
          }

          let should_drop_before_confirm = controls
            .drop_before_confirm_budget
            .try_update(Ordering::AcqRel, Ordering::Acquire, |n| n.checked_sub(1))
            .is_ok();
          if should_drop_before_confirm {
            drop(stream);
            return;
          }

          let should_withhold = controls
            .withhold_confirm_budget
            .try_update(Ordering::AcqRel, Ordering::Acquire, |n| n.checked_sub(1))
            .is_ok();
          if should_withhold {
            continue;
          }

          let should_nack = controls
            .nack_budget
            .try_update(Ordering::AcqRel, Ordering::Acquire, |n| n.checked_sub(1))
            .is_ok();

          let mut confirm_frame = Vec::new();
          confirm_frame.extend_from_slice(&60_u16.to_be_bytes());
          if should_nack {
            // Basic.Nack (60, 120): delivery_tag (u64), bits (u8)
            confirm_frame.extend_from_slice(&120_u16.to_be_bytes());
            confirm_frame.extend_from_slice(&delivery_tag.to_be_bytes());
            confirm_frame.push(0);
          } else {
            state
              .lock()
              .unwrap_or_else(PoisonError::into_inner)
              .publishes
              .push(pub_msg);
            // Basic.Ack (60, 80): delivery_tag (u64), multiple (u8)
            confirm_frame.extend_from_slice(&80_u16.to_be_bytes());
            confirm_frame.extend_from_slice(&delivery_tag.to_be_bytes());
            confirm_frame.push(0);
          }
          if write_frame(&mut stream, 1, channel, &confirm_frame)
            .await
            .is_err()
          {
            break;
          }

          // Simulate a broker restart right after acking the first publish by
          // sending AMQP Connection.Close (10, 50) and awaiting Connection.CloseOk
          // so the client deterministically marks the session closed before the next publish.
          if !should_nack
            && controls
              .drop_after_publish
              .try_update(Ordering::AcqRel, Ordering::Acquire, |n| n.checked_sub(1))
              .is_ok()
          {
            let mut close = Vec::new();
            close.extend_from_slice(&10_u16.to_be_bytes());
            close.extend_from_slice(&50_u16.to_be_bytes());
            close.extend_from_slice(&320_u16.to_be_bytes());
            push_short_str(&mut close, "broker restart");
            close.extend_from_slice(&0_u16.to_be_bytes());
            close.extend_from_slice(&0_u16.to_be_bytes());
            let _ = write_frame(&mut stream, 1, 0, &close).await;
            let _ = tokio::time::timeout(Duration::from_secs(2), read_frame(&mut stream)).await;
            drop(stream);
            controls.dropped_notify.notify_waiters();
            return;
          }
        }
      }
      _ => {}
    }
  }
}

fn make_job(id: &str) -> NuqJob {
  NuqJob {
    id: id.to_owned(),
    status: "active".to_owned(),
    created_at: "2026-11-26T02:00:00.000Z".to_owned(),
    priority: 1,
    data: json!({ "url": "https://example.com" }),
    finished_at: None,
    listen_channel_id: None,
    returnvalue: None,
    failed_reason: None,
    lock: Some("lock-abc".to_owned()),
    owner_id: None,
    group_id: None,
  }
}

#[tokio::test]
async fn amqp_publisher_declares_quorum_queue_publishes_exact_wire_props_and_reconnects() {
  let listener = TcpListener::bind("127.0.0.1:0").await;
  assert!(listener.is_ok());
  let Ok(listener) = listener else { return };
  let addr = listener.local_addr();
  assert!(addr.is_ok());
  let Ok(addr) = addr else { return };

  let captured = Arc::new(Mutex::new(CapturedAmqpWire::default()));
  let controls = Arc::new(MockBrokerControls {
    drop_after_publish: AtomicUsize::new(1),
    drop_before_confirm_budget: AtomicUsize::new(0),
    nack_budget: AtomicUsize::new(0),
    withhold_confirm_budget: AtomicUsize::new(0),
    dropped_notify: Notify::new(),
  });
  let server_state = Arc::clone(&captured);
  let server_controls = Arc::clone(&controls);
  let server = tokio::spawn(async move {
    while let Ok((stream, _)) = listener.accept().await {
      let s = Arc::clone(&server_state);
      let c = Arc::clone(&server_controls);
      tokio::spawn(serve_mock_amqp_connection(stream, s, c));
    }
  });

  let publisher = AmqpPrefetchPublisher::new(Some(RedactedString::new(format!(
    "amqp://guest:guest@{addr}/%2f"
  ))));
  assert!(publisher.is_configured());

  let job1 = make_job("job-001");
  let job2 = NuqJob {
    finished_at: Some("2026-11-26T02:01:00.000Z".to_owned()),
    listen_channel_id: Some("listen-42".to_owned()),
    returnvalue: Some(json!({"markdown": "example"})),
    failed_reason: Some("example reason".to_owned()),
    owner_id: Some("owner-42".to_owned()),
    group_id: Some("group-42".to_owned()),
    ..make_job("job-002")
  };

  assert!(matches!(
    publisher
      .send_job_failed(QueueKind::Scrape, &job1.id, &"é".repeat(128))
      .await,
    Err(PublishError::InvalidShortString("routing key"))
  ));
  assert!(matches!(
    publisher
      .send_job(QueueKind::Scrape, &make_job(&"x".repeat(256)))
      .await,
    Err(PublishError::InvalidShortString("correlation ID"))
  ));

  let drop_wait = controls.dropped_notify.notified();
  tokio::pin!(drop_wait);
  drop_wait.as_mut().enable();
  assert!(publisher.send_job(QueueKind::Scrape, &job1).await.is_ok());

  // Deterministically wait for the mock broker to drop the first TCP connection.
  let dropped = tokio::time::timeout(Duration::from_secs(2), drop_wait).await;
  assert!(
    dropped.is_ok(),
    "mock broker did not drop the first connection"
  );
  assert_eq!(controls.drop_after_publish.load(Ordering::Acquire), 0);

  assert!(publisher.send_job(QueueKind::Scrape, &job2).await.is_ok());
  assert!(
    publisher
      .send_job_failed(QueueKind::Scrape, "job-bad", "listen-42")
      .await
      .is_ok()
  );

  publisher.shutdown().await;
  server.abort();

  let wire = captured.lock().unwrap_or_else(PoisonError::into_inner);
  assert!(
    wire.connections >= 2,
    "expected reconnect after simulated broker drop, got {} connections",
    wire.connections
  );
  assert!(wire.confirm_selects >= 2);
  assert!(wire.declares.len() >= 2);
  for decl in &wire.declares {
    assert_eq!(decl.queue, "nuq.queue_scrape.prefetch");
    assert!(decl.durable);
    assert_eq!(decl.queue_type.as_deref(), Some("quorum"));
    assert_eq!(decl.max_length, Some(20_000));
  }

  assert_eq!(wire.publishes.len(), 3);
  for (pub_msg, job) in wire.publishes.iter().zip([&job1, &job2]) {
    assert_eq!(pub_msg.exchange, "");
    assert_eq!(pub_msg.routing_key, "nuq.queue_scrape.prefetch");
    assert_eq!(pub_msg.delivery_mode, Some(2));
    assert_eq!(pub_msg.correlation_id.as_deref(), Some(job.id.as_str()));
    assert_eq!(pub_msg.expiration.as_deref(), Some("50000"));

    assert_eq!(
      serde_json::to_vec(job).ok().as_deref(),
      Some(pub_msg.body.as_slice())
    );
  }
  if let Some(fail_msg) = wire.publishes.get(2) {
    assert_eq!(fail_msg.exchange, "");
    assert_eq!(fail_msg.routing_key, "nuq.queue_scrape.listen.listen-42");
    assert_eq!(fail_msg.correlation_id.as_deref(), Some("job-bad"));
    assert_eq!(fail_msg.body.as_slice(), b"failed");
  }
  assert!(wire.channel_closes >= 1);
  assert!(wire.connection_closes >= 1);
}

#[tokio::test]
async fn amqp_publisher_returns_error_on_broker_nack() {
  let listener = TcpListener::bind("127.0.0.1:0").await;
  assert!(listener.is_ok());
  let Ok(listener) = listener else { return };
  let addr = listener.local_addr();
  assert!(addr.is_ok());
  let Ok(addr) = addr else { return };

  let captured = Arc::new(Mutex::new(CapturedAmqpWire::default()));
  let controls = Arc::new(MockBrokerControls {
    drop_after_publish: AtomicUsize::new(0),
    drop_before_confirm_budget: AtomicUsize::new(0),
    nack_budget: AtomicUsize::new(1),
    withhold_confirm_budget: AtomicUsize::new(0),
    dropped_notify: Notify::new(),
  });
  let server_state = Arc::clone(&captured);
  let server_controls = Arc::clone(&controls);
  let server = tokio::spawn(async move {
    while let Ok((stream, _)) = listener.accept().await {
      let s = Arc::clone(&server_state);
      let c = Arc::clone(&server_controls);
      tokio::spawn(serve_mock_amqp_connection(stream, s, c));
    }
  });

  let publisher = AmqpPrefetchPublisher::new(Some(RedactedString::new(format!(
    "amqp://guest:guest@{addr}/%2f"
  ))));
  let job = make_job("job-nacked");
  let res = publisher.send_job(QueueKind::Scrape, &job).await;
  assert!(matches!(res, Err(PublishError::Nacked)));
  assert_eq!(controls.nack_budget.load(Ordering::Acquire), 0);

  publisher.shutdown().await;
  server.abort();

  let wire = captured.lock().unwrap_or_else(PoisonError::into_inner);
  assert_eq!(wire.confirm_selects, 1);
  assert_eq!(wire.received_publishes, 1);
  assert!(wire.publishes.is_empty());
}

#[tokio::test]
async fn amqp_publisher_does_not_retry_on_publish_confirm_timeout() {
  let listener = TcpListener::bind("127.0.0.1:0").await;
  assert!(listener.is_ok());
  let Ok(listener) = listener else { return };
  let addr = listener.local_addr();
  assert!(addr.is_ok());
  let Ok(addr) = addr else { return };

  let captured = Arc::new(Mutex::new(CapturedAmqpWire::default()));
  let controls = Arc::new(MockBrokerControls {
    drop_after_publish: AtomicUsize::new(0),
    drop_before_confirm_budget: AtomicUsize::new(0),
    nack_budget: AtomicUsize::new(0),
    withhold_confirm_budget: AtomicUsize::new(0),
    dropped_notify: Notify::new(),
  });
  let server_state = Arc::clone(&captured);
  let server_controls = Arc::clone(&controls);
  let server = tokio::spawn(async move {
    while let Ok((stream, _)) = listener.accept().await {
      let s = Arc::clone(&server_state);
      let c = Arc::clone(&server_controls);
      tokio::spawn(serve_mock_amqp_connection(stream, s, c));
    }
  });

  let publisher = AmqpPrefetchPublisher::with_op_timeout(
    Some(RedactedString::new(format!(
      "amqp://guest:guest@{addr}/%2f"
    ))),
    Duration::from_millis(120),
  );

  // Warm the cached session so the next publish exercises the cached-session path.
  let job1 = make_job("job-warm");
  assert!(publisher.send_job(QueueKind::Scrape, &job1).await.is_ok());

  // Withhold broker confirm on job-2 so delivery outcome is ambiguous.
  controls.withhold_confirm_budget.store(1, Ordering::Release);
  let job2 = make_job("job-confirm-timeout");
  let res = publisher.send_job(QueueKind::Scrape, &job2).await;
  assert!(matches!(res, Err(PublishError::ConfirmTimeout)));
  assert_eq!(controls.withhold_confirm_budget.load(Ordering::Acquire), 0);

  publisher.shutdown().await;
  server.abort();

  let wire = captured.lock().unwrap_or_else(PoisonError::into_inner);
  assert_eq!(wire.connections, 1);
  assert_eq!(wire.confirm_selects, 1);
  // Exactly 2 publishes (job1 + single job2 attempt): no duplicate retry after confirm timeout.
  assert_eq!(wire.received_publishes, 2);
}

#[tokio::test]
async fn amqp_publisher_does_not_retry_on_confirm_transport_drop() {
  let listener = TcpListener::bind("127.0.0.1:0").await;
  assert!(listener.is_ok());
  let Ok(listener) = listener else { return };
  let addr = listener.local_addr();
  assert!(addr.is_ok());
  let Ok(addr) = addr else { return };

  let captured = Arc::new(Mutex::new(CapturedAmqpWire::default()));
  let controls = Arc::new(MockBrokerControls {
    drop_after_publish: AtomicUsize::new(0),
    drop_before_confirm_budget: AtomicUsize::new(0),
    nack_budget: AtomicUsize::new(0),
    withhold_confirm_budget: AtomicUsize::new(0),
    dropped_notify: Notify::new(),
  });
  let server_state = Arc::clone(&captured);
  let server_controls = Arc::clone(&controls);
  let server = tokio::spawn(async move {
    while let Ok((stream, _)) = listener.accept().await {
      let s = Arc::clone(&server_state);
      let c = Arc::clone(&server_controls);
      tokio::spawn(serve_mock_amqp_connection(stream, s, c));
    }
  });

  let publisher = AmqpPrefetchPublisher::new(Some(RedactedString::new(format!(
    "amqp://guest:guest@{addr}/%2f"
  ))));

  let job1 = make_job("job-warm-2");
  assert!(publisher.send_job(QueueKind::Scrape, &job1).await.is_ok());

  // Drop the TCP socket after receiving job-2 frames without sending Basic.Ack.
  controls
    .drop_before_confirm_budget
    .store(1, Ordering::Release);
  let job2 = make_job("job-confirm-eof");
  let res = publisher.send_job(QueueKind::Scrape, &job2).await;
  assert!(matches!(res, Err(PublishError::ConfirmTransport(_))));
  assert_eq!(
    controls.drop_before_confirm_budget.load(Ordering::Acquire),
    0
  );

  {
    let wire = captured.lock().unwrap_or_else(PoisonError::into_inner);
    // Confirm-stage transport failure must not retry job-2 on a fresh connection.
    assert_eq!(wire.connections, 1);
    assert_eq!(wire.received_publishes, 2);
  }

  // Subsequent job reconnects cleanly on a new connection and succeeds.
  let job3 = make_job("job-after-drop");
  assert!(publisher.send_job(QueueKind::Scrape, &job3).await.is_ok());

  publisher.shutdown().await;
  server.abort();

  let wire = captured.lock().unwrap_or_else(PoisonError::into_inner);
  assert_eq!(wire.connections, 2);
  assert_eq!(wire.received_publishes, 3);
}

#[tokio::test]
async fn amqp_publisher_without_url_reports_unconfigured_without_crashing() {
  let publisher = AmqpPrefetchPublisher::new(None);
  assert!(!publisher.is_configured());
  let job = make_job("job-no-rmq");
  assert!(matches!(
    publisher.send_job(QueueKind::CrawlFinished, &job).await,
    Err(PublishError::NotConfigured)
  ));
  publisher.shutdown().await;
}
