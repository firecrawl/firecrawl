use std::sync::{Arc, Mutex, PoisonError};

use opentelemetry::Context;
use opentelemetry::trace::{
  SpanContext, SpanId, TraceContextExt, TraceFlags, TraceId, TraceState, TracerProvider as _,
};
use opentelemetry_sdk::trace::{InMemorySpanExporter, SimpleSpanProcessor};
use tracing_subscriber::layer::{Context as LayerContext, Identity, SubscriberExt};
use tracing_subscriber::{EnvFilter, Layer};

use super::zdr_otel::ZdrTraceRegistry;
use super::{
  TraceContext, ZdrLayer, build_resource, build_tracer_provider_with_registry,
  build_zdr_tracer_provider, extract_trace_context, in_zdr_span, pre_parse_zdr_from_json_str,
  sampler_from_env, spawn_thread_with_span, zdr_span_filter,
};

#[derive(Debug, Clone, Default)]
struct EventCounter(Arc<Mutex<usize>>);

impl<S: tracing::Subscriber> Layer<S> for EventCounter {
  fn on_event(&self, _event: &tracing::Event<'_>, _ctx: LayerContext<'_, S>) {
    let mut count = self.0.lock().unwrap_or_else(PoisonError::into_inner);
    *count = count.saturating_add(1);
  }
}

#[test]
fn late_zdr_record_suppresses_subsequent_and_inflight_child_spans() {
  let exporter = InMemorySpanExporter::default();
  let provider = build_zdr_tracer_provider(
    exporter.clone(),
    build_resource(Some("firecrawl-test"), None),
    sampler_from_env(Some("always_on"), None),
  );
  let tracer = provider.tracer("firecrawl-test");
  let subscriber = tracing_subscriber::registry()
    .with(ZdrLayer)
    .with(tracing_opentelemetry::layer().with_tracer(tracer));

  tracing::subscriber::with_default(subscriber, || {
    let root = tracing::info_span!("scrape_url", zero_data_retention = tracing::field::Empty);
    let _root_guard = root.enter();

    // Forces tracing-opentelemetry to start `root` before ZDR is recorded.
    let inflight_child = tracing::info_span!("inflight_child");
    let inflight_guard = inflight_child.enter();

    // Late ZDR flag recorded while `root` and `inflight_child` are still open.
    root.record("zero_data_retention", true);
    assert!(in_zdr_span());

    // Child created and ended after late ZDR record, before `root` ends.
    let late_child = tracing::info_span!("late_child");
    let _late_guard = late_child.enter();
    drop(_late_guard);
    drop(late_child);

    // Pre-existing child closes after late ZDR record, still before `root` ends.
    drop(inflight_guard);
    drop(inflight_child);
  });

  assert!(provider.force_flush().is_ok());
  let spans = exporter.get_finished_spans();
  assert!(spans.is_ok(), "get_finished_spans failed: {spans:?}");
  if let Ok(spans) = spans {
    assert!(
      spans.is_empty(),
      "expected 0 spans after late ZDR record, got {}",
      spans.len()
    );
  }
}

#[test]
fn zdr_registry_retains_active_traces_and_descendant_tracestate_across_eviction() {
  let exporter = InMemorySpanExporter::default();
  let registry = ZdrTraceRegistry::with_limit(2);
  let provider = build_tracer_provider_with_registry(
    SimpleSpanProcessor::new(exporter.clone()),
    build_resource(Some("firecrawl-test"), None),
    sampler_from_env(Some("always_on"), None),
    registry,
  );
  let tracer = provider.tracer("firecrawl-test");
  let subscriber = tracing_subscriber::registry()
    .with(ZdrLayer)
    .with(tracing_opentelemetry::layer().with_tracer(tracer));

  tracing::subscriber::with_default(subscriber, || {
    // 1. Active trace marked late must survive completed-trace eviction.
    let late_root = tracing::info_span!("late_root", zero_data_retention = tracing::field::Empty);
    let late_guard = late_root.enter();
    let trigger = tracing::info_span!("trigger_start");
    let trigger_guard = trigger.enter();
    late_root.record("zero_data_retention", true);
    drop(trigger_guard);
    drop(trigger);
    drop(late_guard);

    // 2. Dropped ZDR trace must keep its fail-closed descendant TraceState marker
    //    even after many other ZDR traces rotate the completed FIFO.
    let dropped_root = tracing::info_span!("dropped_root", zero_data_retention = true);
    let dropped_guard = dropped_root.enter();
    let first_child = tracing::info_span!("first_child");
    drop(first_child);
    drop(dropped_guard);

    // Flush out the 2-entry completed-trace FIFO with unrelated completed ZDR traces.
    for _ in 0..8 {
      let other = tracing::info_span!("other_zdr", zero_data_retention = true);
      let _g = other.enter();
    }

    // Children created after eviction under both open ZDR roots must stay dropped.
    late_root.in_scope(|| {
      let child = tracing::info_span!("post_eviction_late_child");
      let _g = child.enter();
    });
    dropped_root.in_scope(|| {
      let child = tracing::info_span!("post_eviction_dropped_child");
      let _g = child.enter();
    });

    drop(dropped_root);
    drop(late_root);
  });

  assert!(provider.force_flush().is_ok());
  let spans = exporter.get_finished_spans();
  assert!(spans.is_ok(), "get_finished_spans failed: {spans:?}");
  if let Ok(spans) = spans {
    assert!(
      spans.is_empty(),
      "expected 0 spans after eviction, got {}",
      spans.len()
    );
  }
}

#[test]
fn zdr_registry_keeps_completed_order_bounded_across_repeated_spans() {
  let registry = ZdrTraceRegistry::with_limit(2);
  let trace_id = TraceId::from_bytes([7; 16]);

  for _ in 0..50 {
    registry.on_span_start(trace_id);
    assert!(registry.on_span_end(trace_id, true));
    let (seq_len, order_len) = registry.completed_counts();
    assert_eq!(seq_len, 1);
    assert_eq!(order_len, 1);
  }
  assert!(registry.contains(trace_id));
}

#[test]
fn pre_parse_zdr_handles_escaped_keys_and_fails_closed_on_malformed_json() {
  // Valid JSON with unicode-escaped keys goes through parsed object inspection.
  assert!(pre_parse_zdr_from_json_str(
    r#"{"\u007aeroDataRetention": true}"#
  ));
  assert!(!pre_parse_zdr_from_json_str(
    r#"{"\u007aeroDataRetention": false}"#
  ));

  // Malformed JSON always fails closed regardless of key spelling.
  assert!(pre_parse_zdr_from_json_str(
    r#"{"\u007aeroDataRetention": true, broken"#
  ));
  assert!(pre_parse_zdr_from_json_str("{not valid json"));
  assert!(!pre_parse_zdr_from_json_str(
    r#"{"zeroDataRetention": false}"#
  ));
  assert!(!pre_parse_zdr_from_json_str(
    r#"{"zero_data_retention": false}"#
  ));
  assert!(!pre_parse_zdr_from_json_str("null"));
}

#[test]
fn zdr_layer_vetoes_direct_event_fields_and_suffix_filtered_spans() {
  let counter = EventCounter::default();
  let subscriber = tracing_subscriber::registry()
    .with(Identity::new().with_filter(zdr_span_filter(EnvFilter::new("error"))))
    .with(counter.clone().with_filter(EnvFilter::new("info")))
    .with(ZdrLayer);

  tracing::subscriber::with_default(subscriber, || {
    tracing::info!(zero_data_retention = true, "direct-zdr-event");
    tracing::info!(
      request.zero_data_retention = "truthy",
      "direct-suffixed-zdr-event"
    );
    tracing::info!(zero_data_retention = false, "visible-event");

    // Under RUST_LOG=error, a suffixed ZDR field on an info_span! stays active.
    let suffixed_span = tracing::info_span!("op", request.zero_data_retention = true);
    suffixed_span.in_scope(|| {
      assert!(in_zdr_span());
      tracing::error!("suppressed-inside-suffixed-span");
      tracing::info!("suppressed-even-when-only-the-output-layer-enables-it");
    });
  });

  let count = *counter.0.lock().unwrap_or_else(PoisonError::into_inner);
  assert_eq!(count, 1, "only the explicit non-ZDR event should pass");
}

#[test]
fn extract_trace_context_ignores_ambient_current_context_on_malformed_traceparent() {
  let ambient_span_context = SpanContext::new(
    TraceId::from_bytes([1; 16]),
    SpanId::from_bytes([2; 8]),
    TraceFlags::SAMPLED,
    true,
    TraceState::default(),
  );
  let ambient_cx = Context::new().with_remote_span_context(ambient_span_context);
  let _guard = ambient_cx.attach();

  let malformed = TraceContext {
    traceparent: Some("not-a-valid-traceparent".to_string()),
    tracestate: None,
  };
  assert!(extract_trace_context(&malformed).is_none());
}

#[test]
fn spawn_thread_with_span_preserves_zdr_scope() {
  let subscriber = tracing_subscriber::registry().with(ZdrLayer);
  let saw_zdr = tracing::subscriber::with_default(subscriber, || {
    let zdr_span = tracing::info_span!("derive_core_html", zero_data_retention = true);
    zdr_span.in_scope(|| {
      let handle = spawn_thread_with_span("zdr-os-worker", in_zdr_span);
      assert!(handle.is_ok(), "spawn_thread_with_span failed: {handle:?}");
      let Ok(handle) = handle else {
        return false;
      };
      let joined = handle.join();
      assert!(joined.is_ok(), "worker thread panicked: {joined:?}");
      joined.unwrap_or(false)
    })
  });

  assert!(
    saw_zdr,
    "spawn_thread_with_span must preserve in_zdr_span()"
  );
}
