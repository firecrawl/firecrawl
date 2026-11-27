//! Executable verification harness proving W3C parent propagation, pre-parse
//! ZDR override against sampled `traceparent`, cross-thread ZDR span
//! propagation (`spawn_blocking`, scoped `rayon`, and OS threads), and ZDR
//! panic payload withholding.

use std::process::Command;
use std::sync::{Arc, Mutex, PoisonError};

use opentelemetry::trace::{SpanId, TraceContextExt as _, TraceId, TracerProvider as _};
use opentelemetry_sdk::trace::InMemorySpanExporter;
use tracing::field::Visit;
use tracing_opentelemetry::OpenTelemetrySpanExt as _;
use tracing_subscriber::layer::{Context as LayerContext, Identity, SubscriberExt};
use tracing_subscriber::{EnvFilter, Layer, fmt};

use firecrawl_core::telemetry::{
  TraceContext, ZdrLayer, attach_parent_context, build_resource, build_zdr_tracer_provider,
  in_zdr_span, install_zdr_panic_hook, pre_parse_zdr_from_json_str, run_on_scoped_rayon_pool,
  sampler_from_env, spawn_blocking_with_span, spawn_thread_with_span, zdr_span_filter,
};

#[derive(Debug, Clone, Default)]
struct EventCapture {
  messages: Arc<Mutex<Vec<String>>>,
}

struct MessageVisitor {
  msg: String,
}

impl Visit for MessageVisitor {
  fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
    if field.name() == "message" {
      self.msg = value.to_owned();
    }
  }

  fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
    if field.name() == "message" {
      self.msg = format!("{value:?}");
    }
  }
}

impl<S: tracing::Subscriber> Layer<S> for EventCapture {
  fn on_event(&self, event: &tracing::Event<'_>, _ctx: LayerContext<'_, S>) {
    let mut visitor = MessageVisitor { msg: String::new() };
    event.record(&mut visitor);
    self
      .messages
      .lock()
      .unwrap_or_else(PoisonError::into_inner)
      .push(visitor.msg);
  }
}

fn verify_w3c_and_zdr() -> Result<(), String> {
  let trace_hex = "4bf92f3577b34da6a3ce929d0e0e4736";
  let parent_span_hex = "00f067aa0ba902b7";
  let expected_trace = TraceId::from_hex(trace_hex).map_err(|e| format!("trace hex: {e}"))?;
  let expected_parent = SpanId::from_hex(parent_span_hex).map_err(|e| format!("span hex: {e}"))?;
  let traceparent = format!("00-{trace_hex}-{parent_span_hex}-01");
  let tracestate = "firecrawl=test".to_string();

  let trace_ctx = TraceContext {
    traceparent: Some(traceparent),
    tracestate: Some(tracestate.clone()),
  };

  let exporter = InMemorySpanExporter::default();
  let provider = build_zdr_tracer_provider(
    exporter.clone(),
    build_resource(Some("firecrawl-api-verify"), Some("pod-verify-1")),
    sampler_from_env(Some("always_on"), None),
  );
  let tracer = provider.tracer("firecrawl-verify");
  let capture = EventCapture::default();

  let subscriber = tracing_subscriber::registry()
    .with(ZdrLayer)
    .with(capture.clone())
    .with(tracing_opentelemetry::layer().with_tracer(tracer));

  let rt = tokio::runtime::Builder::new_multi_thread()
    .worker_threads(2)
    .enable_all()
    .build()
    .map_err(|e| format!("failed to build tokio runtime: {e}"))?;

  tracing::subscriber::with_default(subscriber, || -> Result<(), String> {
    // 1. Non-ZDR call with W3C traceparent propagates parent trace_id, span_id, tracestate.
    let non_zdr_span = tracing::info_span!("derive_core_html", zero_data_retention = false);
    attach_parent_context(&non_zdr_span, Some(&trace_ctx), false);
    non_zdr_span.in_scope(|| {
      tracing::info!("non-zdr-visible-event");
      let child = tracing::info_span!("extract_links");
      let _g = child.enter();
    });
    drop(non_zdr_span);

    // 2. ZDR call with SAMPLED traceparent (-01) and always_on sampler emits 0 spans & 0 events,
    //    deriving the span flag directly from pre_parse_zdr_from_json_str and preserving
    //    in_zdr_span() across spawn_blocking, scoped rayon, and OS threads.
    let raw_zdr = r#"{"zeroDataRetention": "truthy-string"}"#;
    let pre_parsed_zdr = pre_parse_zdr_from_json_str(raw_zdr);
    if !pre_parsed_zdr {
      return Err("pre_parse_zdr_from_json_str failed on non-false string".to_string());
    }
    let zdr_span = tracing::info_span!("derive_core_html", zero_data_retention = pre_parsed_zdr);
    attach_parent_context(&zdr_span, Some(&trace_ctx), pre_parsed_zdr);
    let zdr_context = zdr_span.context();
    let zdr_otel_span = zdr_context.span();
    let zdr_span_context = zdr_otel_span.span_context();
    if zdr_span_context.is_sampled() || zdr_span_context.trace_id() == expected_trace {
      return Err("ZDR span inherited the sampled remote trace".to_string());
    }
    zdr_span.in_scope(|| -> Result<(), String> {
      tracing::error!("zdr-secret-event-must-be-suppressed");
      if !in_zdr_span() {
        return Err("in_zdr_span() was false on ZDR caller thread".to_string());
      }

      let blocking_saw_zdr = rt
        .block_on(spawn_blocking_with_span(rt.handle(), || {
          tracing::error!("zdr-blocking-secret-must-be-suppressed");
          in_zdr_span()
        }))
        .map_err(|e| format!("spawn_blocking join failed: {e}"))?;
      if !blocking_saw_zdr {
        return Err("in_zdr_span() was false inside spawn_blocking_with_span".to_string());
      }

      let rayon_saw_zdr = run_on_scoped_rayon_pool(2, || {
        tracing::error!("zdr-rayon-secret-must-be-suppressed");
        in_zdr_span()
      })
      .map_err(|e| format!("scoped rayon pool failed: {e}"))?;
      if !rayon_saw_zdr {
        return Err("in_zdr_span() was false inside run_on_scoped_rayon_pool".to_string());
      }

      let os_thread_saw_zdr = spawn_thread_with_span("verify-zdr-os", || {
        tracing::error!("zdr-os-thread-secret-must-be-suppressed");
        in_zdr_span()
      })
      .map_err(|e| format!("spawn_thread_with_span failed: {e}"))?
      .join()
      .map_err(|_| "OS worker thread panicked".to_string())?;
      if !os_thread_saw_zdr {
        return Err("in_zdr_span() was false inside spawn_thread_with_span".to_string());
      }

      Ok(())
    })?;
    drop(zdr_span);

    let control = tracing::info_span!("non_zdr_after_override", zero_data_retention = false);
    attach_parent_context(&control, Some(&trace_ctx), false);
    drop(control);
    Ok(())
  })?;

  provider
    .force_flush()
    .map_err(|e| format!("force_flush failed: {e}"))?;
  let spans = exporter
    .get_finished_spans()
    .map_err(|e| format!("failed to read finished spans: {e}"))?;

  if spans.len() != 3 {
    return Err(format!("expected 3 non-ZDR spans, got {}", spans.len()));
  }

  let control = spans
    .iter()
    .find(|s| s.name == "non_zdr_after_override")
    .ok_or_else(|| "missing non-ZDR control span after ZDR override".to_string())?;
  if control.span_context.trace_id() != expected_trace || control.parent_span_id != expected_parent
  {
    return Err("non-ZDR control span did not retain the remote parent".to_string());
  }

  let root_exported = spans
    .iter()
    .find(|s| s.name == "derive_core_html")
    .ok_or_else(|| "missing derive_core_html span".to_string())?;
  if root_exported.span_context.trace_id() != expected_trace {
    return Err(format!(
      "trace_id mismatch: got {}, expected {expected_trace}",
      root_exported.span_context.trace_id()
    ));
  }
  if root_exported.parent_span_id != expected_parent {
    return Err(format!(
      "parent_span_id mismatch: got {}, expected {expected_parent}",
      root_exported.parent_span_id
    ));
  }
  if root_exported.span_context.trace_state().header() != tracestate {
    return Err(format!(
      "tracestate mismatch: got {}",
      root_exported.span_context.trace_state().header()
    ));
  }

  let events = capture
    .messages
    .lock()
    .unwrap_or_else(PoisonError::into_inner)
    .clone();
  if events != vec!["non-zdr-visible-event".to_string()] {
    return Err(format!("unexpected captured events: {events:?}"));
  }

  println!(
    "OK w3c_propagation=true trace_id={} parent_span_id={} tracestate={} non_zdr_spans={} zdr_spans=0 suppressed_zdr_events=4 cross_thread_zdr=true",
    root_exported.span_context.trace_id(),
    root_exported.parent_span_id,
    root_exported.span_context.trace_state().header(),
    spans.len(),
  );
  Ok(())
}

#[allow(clippy::panic)]
fn run_zdr_panic_hook_worker() -> Result<(), String> {
  struct InstallOnDrop;
  impl Drop for InstallOnDrop {
    fn drop(&mut self) {
      install_zdr_panic_hook();
    }
  }

  if std::panic::catch_unwind(|| {
    let _install = InstallOnDrop;
    std::panic::panic_any("verify first installation during unwind");
  })
  .is_ok()
  {
    return Err("expected panic before hook installation".to_string());
  }
  install_zdr_panic_hook();

  let rt = tokio::runtime::Builder::new_multi_thread()
    .worker_threads(2)
    .enable_all()
    .build()
    .map_err(|e| format!("failed to build tokio runtime: {e}"))?;

  // Even under RUST_LOG=error, zdr_span_filter keeps ZDR info_span! active.
  let subscriber = tracing_subscriber::registry()
    .with(Identity::new().with_filter(zdr_span_filter(EnvFilter::new("error"))))
    .with(
      fmt::layer()
        .with_writer(std::io::stderr)
        .with_filter(EnvFilter::new("error")),
    )
    .with(ZdrLayer);
  tracing::subscriber::with_default(subscriber, || -> Result<(), String> {
    let zdr_span = tracing::info_span!("derive_core_html", zero_data_retention = true);
    tracing::error!(zero_data_retention = true, "SUPER_SECRET_DIRECT_ZDR_LOG");
    let direct_panic = zdr_span.in_scope(|| {
      tracing::error!("SUPER_SECRET_SCOPED_ZDR_LOG");
      std::panic::catch_unwind(|| {
        std::panic::panic_any("SUPER_SECRET_ZDR_CUSTOMER_PAYLOAD");
      })
    });
    if direct_panic.is_ok() {
      return Err("expected direct ZDR closure to panic".to_string());
    }

    let blocking_result = zdr_span.in_scope(|| {
      rt.block_on(spawn_blocking_with_span(rt.handle(), || {
        std::panic::panic_any("SUPER_SECRET_BLOCKING_ZDR_PAYLOAD");
      }))
    });
    match blocking_result {
      Err(err) if err.is_panic() => {}
      other => return Err(format!("expected spawn_blocking ZDR panic, got {other:?}")),
    }

    let rayon_panic = zdr_span.in_scope(|| {
      run_on_scoped_rayon_pool(2, || {
        std::panic::catch_unwind(|| {
          std::panic::panic_any("SUPER_SECRET_RAYON_ZDR_PAYLOAD");
        })
      })
    });
    match rayon_panic {
      Ok(Err(_)) => {}
      Ok(Ok(())) => return Err("expected scoped rayon ZDR closure to panic".to_string()),
      Err(err) => return Err(format!("failed to build scoped rayon pool: {err}")),
    }

    let os_thread_result = zdr_span.in_scope(|| {
      spawn_thread_with_span("zdr-panic-os", || {
        std::panic::panic_any("SUPER_SECRET_OS_THREAD_ZDR_PAYLOAD");
      })
      .map_err(|e| format!("spawn_thread_with_span failed: {e}"))?
      .join()
      .map_or(Ok(()), |()| {
        Err("expected OS worker thread to panic".to_string())
      })
    });
    os_thread_result?;

    let non_zdr_span = tracing::info_span!("derive_core_html", zero_data_retention = false);
    let non_zdr_panic = non_zdr_span.in_scope(|| {
      tracing::error!("NON_ZDR_VISIBLE_LOG");
      std::panic::catch_unwind(|| {
        std::panic::panic_any("NON_ZDR_DIAGNOSTIC_PAYLOAD");
      })
    });
    if non_zdr_panic.is_ok() {
      return Err("expected non-ZDR closure to panic".to_string());
    }

    Ok(())
  })
}

fn verify_zdr_panic_hook() -> Result<(), String> {
  let exe = std::env::current_exe().map_err(|e| format!("current_exe failed: {e}"))?;
  let output = Command::new(exe)
    .arg("panic-hook-worker")
    .output()
    .map_err(|e| format!("failed to spawn panic-hook-worker: {e}"))?;

  let stderr = String::from_utf8_lossy(&output.stderr);
  if !output.status.success() {
    return Err(format!(
      "panic-hook-worker failed with {}: {stderr}",
      output.status
    ));
  }

  if stderr.contains("SUPER_SECRET_") {
    return Err(format!("ZDR panic payload leaked to stderr:\n{stderr}"));
  }

  let withheld_count = stderr
    .lines()
    .filter(|line| line.contains("panic payload withheld (zero data retention)"))
    .count();
  if withheld_count != 4 {
    return Err(format!(
      "expected 4 withheld ZDR panic lines, got {withheld_count}:\n{stderr}"
    ));
  }

  if !stderr.contains("NON_ZDR_DIAGNOSTIC_PAYLOAD") {
    return Err(format!(
      "expected non-ZDR diagnostic payload in stderr:\n{stderr}"
    ));
  }
  if !stderr.contains("NON_ZDR_VISIBLE_LOG") {
    return Err("expected non-ZDR log in stderr".to_string());
  }

  println!(
    "OK panic_hook_verified=true withheld_count={withheld_count} leaked_zdr_payloads=0 non_zdr_preserved=true"
  );
  Ok(())
}

fn main() -> Result<(), String> {
  let mode = std::env::args().nth(1);
  match mode.as_deref() {
    Some("panic-hook") => verify_zdr_panic_hook(),
    Some("panic-hook-worker") => run_zdr_panic_hook_worker(),
    None => verify_w3c_and_zdr(),
    Some(other) => Err(format!("unknown verify_telemetry mode: {other}")),
  }
}
