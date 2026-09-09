use napi_derive::napi;
use serde::Serialize;
use serde_json::Value;
use std::sync::{Arc, Mutex};
use tracing::field::{Field, Visit};
use tracing::Level;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::Layer;

/// Context passed from TypeScript to continue the trace.
#[derive(Clone)]
#[napi(object)]
pub struct NativeContext {
  pub scrape_id: String,
  pub url: String,
}

/// A single log entry captured during Rust execution.
#[derive(Clone, Debug, Serialize)]
#[napi(object)]
pub struct NativeLogEntry {
  pub level: String,
  pub target: String,
  pub message: String,
  pub fields: Value,
  pub timestamp_ms: f64,
}

struct LogCollector {
  logs: Arc<Mutex<Vec<NativeLogEntry>>>,
}

struct FieldVisitor {
  fields: serde_json::Map<String, Value>,
  message: Option<String>,
}

impl Visit for FieldVisitor {
  fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
    if field.name() == "message" {
      self.message = Some(format!("{:?}", value));
    } else {
      self.fields.insert(
        field.name().to_string(),
        Value::String(format!("{:?}", value)),
      );
    }
  }

  fn record_str(&mut self, field: &Field, value: &str) {
    if field.name() == "message" {
      self.message = Some(value.to_string());
    } else {
      self
        .fields
        .insert(field.name().to_string(), Value::String(value.to_string()));
    }
  }

  fn record_i64(&mut self, field: &Field, value: i64) {
    self
      .fields
      .insert(field.name().to_string(), Value::Number(value.into()));
  }

  fn record_u64(&mut self, field: &Field, value: u64) {
    self
      .fields
      .insert(field.name().to_string(), Value::Number(value.into()));
  }

  fn record_f64(&mut self, field: &Field, value: f64) {
    if let Some(n) = serde_json::Number::from_f64(value) {
      self
        .fields
        .insert(field.name().to_string(), Value::Number(n));
    }
  }

  fn record_bool(&mut self, field: &Field, value: bool) {
    self
      .fields
      .insert(field.name().to_string(), Value::Bool(value));
  }
}

impl<S: tracing::Subscriber> Layer<S> for LogCollector {
  fn on_event(&self, event: &tracing::Event<'_>, _ctx: tracing_subscriber::layer::Context<'_, S>) {
    let mut visitor = FieldVisitor {
      fields: serde_json::Map::new(),
      message: None,
    };
    event.record(&mut visitor);

    let level = match *event.metadata().level() {
      Level::ERROR => "error",
      Level::WARN => "warn",
      Level::INFO => "info",
      Level::DEBUG => "debug",
      Level::TRACE => "trace",
    };

    let entry = NativeLogEntry {
      level: level.to_string(),
      target: event.metadata().target().to_string(),
      message: visitor.message.unwrap_or_default(),
      fields: Value::Object(visitor.fields),
      timestamp_ms: std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0),
    };

    if let Ok(mut logs) = self.logs.lock() {
      logs.push(entry);
    }
  }
}

#[derive(Debug)]
pub struct TracingResult<T> {
  pub value: T,
  pub logs: Vec<NativeLogEntry>,
}

/// Run a closure with tracing enabled, capturing all log events.
/// Wraps the closure in `catch_unwind` for panic safety.
///
/// Returns `TracingResult<napi::Result<T>>` so that logs are **always**
/// available — even when the closure returns `Err` or panics.
pub fn with_native_tracing<T, F>(
  ctx: Option<&NativeContext>,
  module: &str,
  f: F,
) -> TracingResult<napi::Result<T>>
where
  F: FnOnce() -> napi::Result<T>,
{
  let logs = Arc::new(Mutex::new(Vec::new()));
  let collector = LogCollector { logs: logs.clone() };
  let subscriber = tracing_subscriber::Registry::default().with(collector);

  let result = tracing::subscriber::with_default(subscriber, || {
    let _span = match ctx {
      Some(c) => tracing::info_span!(
        "native",
        scrape_id = %c.scrape_id,
        url = %c.url,
        module = %module,
      )
      .entered(),
      None => tracing::info_span!("native", module = %module).entered(),
    };

    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
      Ok(result) => result,
      Err(panic_info) => {
        let msg = if let Some(s) = panic_info.downcast_ref::<&str>() {
          s.to_string()
        } else if let Some(s) = panic_info.downcast_ref::<String>() {
          s.clone()
        } else {
          "unknown panic".to_string()
        };
        let backtrace = std::backtrace::Backtrace::force_capture();
        tracing::error!(
          panic = true,
          backtrace = %backtrace,
          "native panic in {}: {}", module, msg,
        );

        Err(napi::Error::new(
          napi::Status::GenericFailure,
          format!("Rust panic in {module}: {msg}\nBacktrace:\n{backtrace}"),
        ))
      }
    }
  });

  let collected = logs.lock().map(|l| l.clone()).unwrap_or_default();

  TracingResult {
    value: result,
    logs: collected,
  }
}

/// Append serialized logs to a NAPI error so they survive the FFI boundary.
/// The TS side can extract them from `error.message` via `extractNativeLogs`.
pub fn embed_logs_in_error(err: napi::Error, logs: &[NativeLogEntry]) -> napi::Error {
  if logs.is_empty() {
    return err;
  }
  if let Ok(logs_json) = serde_json::to_string(logs) {
    napi::Error::new(
      err.status,
      format!("{}\n__native_logs__:{logs_json}", err.reason),
    )
  } else {
    err
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn test_collects_logs() {
    let traced = with_native_tracing(None, "test", || {
      tracing::info!("hello from rust");
      Ok(42)
    });

    let value = traced.value.unwrap();
    assert_eq!(value, 42);
    assert_eq!(traced.logs.len(), 1);
    assert_eq!(traced.logs[0].level, "info");
    assert!(traced.logs[0].message.contains("hello from rust"));
  }

  #[test]
  fn test_with_context() {
    let ctx = NativeContext {
      scrape_id: "test-123".to_string(),
      url: "https://example.com".to_string(),
    };
    let traced = with_native_tracing(Some(&ctx), "pdf", || {
      tracing::warn!("something odd");
      Ok("ok")
    });

    assert_eq!(traced.value.unwrap(), "ok");
    assert_eq!(traced.logs.len(), 1);
    assert_eq!(traced.logs[0].level, "warn");
  }

  #[test]
  fn test_captures_panic_with_logs() {
    let traced: TracingResult<napi::Result<()>> = with_native_tracing(None, "test", || {
      panic!("test panic");
    });

    assert!(traced.value.is_err());
    let err = traced.value.unwrap_err();
    assert!(err.reason.contains("test panic"));
    assert!(err.reason.contains("Backtrace"));
    // Panic log is preserved even though the closure failed
    assert!(!traced.logs.is_empty());
    assert_eq!(traced.logs[0].level, "error");
    assert!(traced.logs[0].message.contains("test panic"));
  }

  #[test]
  fn test_error_preserves_logs() {
    let traced: TracingResult<napi::Result<()>> = with_native_tracing(None, "test", || {
      tracing::info!("before error");
      Err(napi::Error::new(napi::Status::GenericFailure, "test error"))
    });

    assert!(traced.value.is_err());
    // Logs are preserved even on error paths
    assert_eq!(traced.logs.len(), 1);
    assert_eq!(traced.logs[0].level, "info");
    assert!(traced.logs[0].message.contains("before error"));
  }
}
