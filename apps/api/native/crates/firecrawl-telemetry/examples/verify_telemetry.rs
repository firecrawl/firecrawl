//! Executable verification harness proving W3C parent propagation, pre-parse
//! ZDR override against sampled `traceparent`, cross-thread ZDR span
//! propagation (`spawn_blocking` + scoped `rayon`), and ZDR panic payload
//! withholding.

use std::sync::{Arc, Mutex, PoisonError};

use opentelemetry::trace::{SpanId, TraceId, TracerProvider as _};
use opentelemetry_sdk::trace::InMemorySpanExporter;
use tracing::field::Visit;
use tracing_subscriber::layer::{Context as LayerContext, SubscriberExt};
use tracing_subscriber::{EnvFilter, Layer};

use firecrawl_telemetry::{
  FlushGuard, TraceContext, ZdrLayer, attach_parent_context, build_resource,
  build_zdr_tracer_provider, in_zdr_span, install_zdr_panic_hook, pre_parse_zdr_from_json_str,
  run_on_scoped_rayon_pool, sampler_from_env, spawn_blocking_with_span, zdr_span_filter,
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
    //    and preserves in_zdr_span() across spawn_blocking and scoped rayon threads.
    let raw_zdr = r#"{"zeroDataRetention": "truthy-string"}"#;
    if !pre_parse_zdr_from_json_str(raw_zdr) {
      return Err("pre_parse_zdr_from_json_str failed on non-false string".to_string());
    }
    let zdr_span = tracing::info_span!("derive_core_html", zero_data_retention = true);
    attach_parent_context(&zdr_span, Some(&trace_ctx), true);
    zdr_span.in_scope(|| -> Result<(), String> {
      tracing::error!("zdr-secret-event-must-be-suppressed");
      if !in_zdr_span() {
        return Err("in_zdr_span() was false on ZDR caller thread".to_string());
      }

      let blocking_saw_zdr = rt
        .block_on(async {
          spawn_blocking_with_span(|| {
            tracing::error!("zdr-blocking-secret-must-be-suppressed");
            in_zdr_span()
          })
          .await
        })
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

      Ok(())
    })?;
    drop(zdr_span);
    Ok(())
  })?;

  let _ = provider.force_flush();
  let spans = exporter
    .get_finished_spans()
    .map_err(|e| format!("failed to read finished spans: {e}"))?;

  let expected_trace = TraceId::from_hex(trace_hex).map_err(|e| format!("trace hex: {e}"))?;
  let expected_parent = SpanId::from_hex(parent_span_hex).map_err(|e| format!("span hex: {e}"))?;

  if spans.len() != 2 {
    return Err(format!("expected 2 non-ZDR spans, got {}", spans.len()));
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
    "OK w3c_propagation=true trace_id={} parent_span_id={} tracestate={} non_zdr_spans={} zdr_spans=0 suppressed_zdr_events=3 cross_thread_zdr=true",
    root_exported.span_context.trace_id(),
    root_exported.parent_span_id,
    root_exported.span_context.trace_state().header(),
    spans.len(),
  );
  Ok(())
}

#[allow(clippy::panic)]
fn verify_zdr_panic_hook() -> Result<(), String> {
  let _flush = FlushGuard;
  install_zdr_panic_hook();

  let rt = tokio::runtime::Builder::new_multi_thread()
    .worker_threads(2)
    .enable_all()
    .build()
    .map_err(|e| format!("failed to build tokio runtime: {e}"))?;

  // Even under RUST_LOG=error, zdr_span_filter keeps ZDR info_span! active.
  let subscriber = tracing_subscriber::registry()
    .with(ZdrLayer.with_filter(zdr_span_filter(EnvFilter::new("error"))));
  tracing::subscriber::with_default(subscriber, || {
    let zdr_span = tracing::info_span!("derive_core_html", zero_data_retention = true);
    let _ = zdr_span.in_scope(|| {
      std::panic::catch_unwind(|| {
        std::panic::panic_any("SUPER_SECRET_ZDR_CUSTOMER_PAYLOAD");
      })
    });

    zdr_span.in_scope(|| {
      let _ = rt.block_on(async {
        spawn_blocking_with_span(|| {
          std::panic::panic_any("SUPER_SECRET_BLOCKING_ZDR_PAYLOAD");
        })
        .await
      });
    });

    zdr_span.in_scope(|| {
      let _ = run_on_scoped_rayon_pool(2, || {
        let _ = std::panic::catch_unwind(|| {
          std::panic::panic_any("SUPER_SECRET_RAYON_ZDR_PAYLOAD");
        });
      });
    });

    let non_zdr_span = tracing::info_span!("derive_core_html", zero_data_retention = false);
    let _ = non_zdr_span.in_scope(|| {
      std::panic::catch_unwind(|| {
        std::panic::panic_any("NON_ZDR_DIAGNOSTIC_PAYLOAD");
      })
    });
  });

  println!("OK panic_hook_executed=true");
  Ok(())
}

fn main() -> Result<(), String> {
  let mode = std::env::args().nth(1);
  match mode.as_deref() {
    Some("panic-hook") => verify_zdr_panic_hook(),
    _ => verify_w3c_and_zdr(),
  }
}
