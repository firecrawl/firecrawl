use hegel::{TestCase, generators as gs};
use opentelemetry::trace::{SpanKind, TraceId, TracerProvider as _};
use opentelemetry::{KeyValue, Value};
use opentelemetry_sdk::trace::{InMemorySpanExporter, SamplingDecision, ShouldSample};
use tracing_subscriber::layer::SubscriberExt;

use super::{
  TraceContext, ZdrLayer, ZeroDataRetentionSampler, attach_parent_context, build_resource,
  build_zdr_tracer_provider, extract_trace_context, pre_parse_zdr_from_json_str, sampler_from_env,
};

const SAMPLERS: &[&str] = &[
  "always_on",
  "always_off",
  "traceidratio",
  "parentbased_always_on",
  "parentbased_always_off",
  "parentbased_traceidratio",
];

fn hex_lower(bytes: &[u8]) -> String {
  const HEX: &[u8; 16] = b"0123456789abcdef";
  let mut out = String::with_capacity(bytes.len().saturating_mul(2));
  for &byte in bytes {
    let hi = usize::from(byte >> 4);
    let lo = usize::from(byte & 0x0f);
    if let (Some(&h), Some(&l)) = (HEX.get(hi), HEX.get(lo)) {
      out.push(char::from(h));
      out.push(char::from(l));
    }
  }
  out
}

#[hegel::composite]
fn non_zero_trace_id_bytes(tc: &TestCase) -> [u8; 16] {
  let mut bytes = [0u8; 16];
  for slot in &mut bytes {
    *slot = tc.draw(gs::integers::<u8>());
  }
  if bytes.iter().all(|&b| b == 0)
    && let Some(last) = bytes.last_mut()
  {
    *last = 1;
  }
  bytes
}

#[hegel::composite]
fn non_zero_span_id_bytes(tc: &TestCase) -> [u8; 8] {
  let mut bytes = [0u8; 8];
  for slot in &mut bytes {
    *slot = tc.draw(gs::integers::<u8>());
  }
  if bytes.iter().all(|&b| b == 0)
    && let Some(last) = bytes.last_mut()
  {
    *last = 1;
  }
  bytes
}

#[hegel::composite]
fn non_false_otel_value(tc: &TestCase) -> Value {
  match tc.draw(gs::integers::<u8>().max_value(3)) {
    0 => Value::Bool(true),
    1 => Value::I64(tc.draw(gs::integers::<i64>())),
    2 => Value::String(tc.draw(gs::text().max_size(24)).into()),
    _ => Value::F64(tc.draw(gs::integers::<i32>()).into()),
  }
}

/// ZDR must always drop spans (and child spans in the same trace) even when
/// paired with a sampled W3C `traceparent` (`-01`) and any `OTEL_TRACES_SAMPLER`.
#[hegel::test]
fn zdr_sampler_drops_even_with_sampled_traceparent(tc: TestCase) {
  let trace_bytes = tc.draw(non_zero_trace_id_bytes());
  let span_bytes = tc.draw(non_zero_span_id_bytes());
  let sampled_flag = if tc.draw(gs::booleans()) { "01" } else { "00" };
  let traceparent = format!(
    "00-{}-{}-{sampled_flag}",
    hex_lower(&trace_bytes),
    hex_lower(&span_bytes)
  );
  let tracestate = tc.draw(gs::booleans()).then(|| "vendor=value".to_string());

  let ctx = TraceContext {
    traceparent: Some(traceparent),
    tracestate,
  };
  let parent_cx = extract_trace_context(&ctx);
  assert!(parent_cx.is_some());

  let sampler_name = tc.draw(gs::sampled_from(SAMPLERS));
  let ratio_arg = match tc.draw(gs::integers::<u8>().max_value(3)) {
    0 => Some("0.0"),
    1 => Some("0.5"),
    2 => Some("1.0"),
    _ => None,
  };
  let delegate = sampler_from_env(Some(sampler_name), ratio_arg);
  let sampler = ZeroDataRetentionSampler::new(delegate);

  let trace_id = TraceId::from_bytes(trace_bytes);
  let attr_key = if tc.draw(gs::booleans()) {
    "zero_data_retention"
  } else {
    "firecrawl.zero_data_retention"
  };
  let attr_val = tc.draw(non_false_otel_value());

  let root_result = sampler.should_sample(
    parent_cx.as_ref(),
    trace_id,
    "native_entry",
    &SpanKind::Internal,
    &[KeyValue::new(attr_key, attr_val)],
    &[],
  );
  assert_eq!(root_result.decision, SamplingDecision::Drop);

  // Any child span sharing the trace ID must also be dropped even without a
  // ZDR attribute and even when the delegate sampler is `always_on`.
  let child_result = sampler.should_sample(
    parent_cx.as_ref(),
    trace_id,
    "native_child",
    &SpanKind::Internal,
    &[],
    &[],
  );
  assert_eq!(child_result.decision, SamplingDecision::Drop);
}

/// End-to-end subscriber invariant: a ZDR span with a sampled W3C `traceparent`
/// exports zero spans, while a non-ZDR span with sampled `traceparent` under
/// `parentbased_always_on` exports with the exact parent trace and span IDs.
#[hegel::test]
fn zdr_overrides_sampled_w3c_parent_in_subscriber(tc: TestCase) {
  let trace_bytes = tc.draw(non_zero_trace_id_bytes());
  let span_bytes = tc.draw(non_zero_span_id_bytes());
  let is_zdr = tc.draw(gs::booleans());
  let traceparent = format!(
    "00-{}-{}-01",
    hex_lower(&trace_bytes),
    hex_lower(&span_bytes)
  );
  let ctx = TraceContext {
    traceparent: Some(traceparent),
    tracestate: None,
  };

  let exporter = InMemorySpanExporter::default();
  let provider = build_zdr_tracer_provider(
    exporter.clone(),
    build_resource(Some("firecrawl-test"), Some("pod-0")),
    sampler_from_env(Some("parentbased_always_on"), None),
  );
  let tracer = provider.tracer("firecrawl-test");
  let subscriber = tracing_subscriber::registry()
    .with(ZdrLayer)
    .with(tracing_opentelemetry::layer().with_tracer(tracer));

  tracing::subscriber::with_default(subscriber, || {
    let root = tracing::info_span!("native_op", zero_data_retention = is_zdr);
    attach_parent_context(&root, Some(&ctx), is_zdr);
    let _enter = root.enter();
    let child = tracing::info_span!("native_child");
    let _child_enter = child.enter();
  });

  let flush_result = provider.force_flush();
  assert!(flush_result.is_ok(), "force_flush failed: {flush_result:?}");
  let spans_result = exporter.get_finished_spans();
  assert!(
    spans_result.is_ok(),
    "get_finished_spans failed: {spans_result:?}"
  );
  let Ok(spans) = spans_result else {
    return;
  };

  if is_zdr {
    assert!(
      spans.is_empty(),
      "expected 0 spans for ZDR, got {}",
      spans.len()
    );
  } else {
    assert_eq!(spans.len(), 2);
    let expected_trace_id = TraceId::from_bytes(trace_bytes);
    for span in &spans {
      assert_eq!(span.span_context.trace_id(), expected_trace_id);
    }
  }
}

/// Pre-parse ZDR inspection treats every `zeroDataRetention` value other than
/// explicit `false` as ZDR.
#[hegel::test]
fn pre_parse_zdr_treats_any_non_false_value_as_zdr(tc: TestCase) {
  let value = tc.draw(hegel::extras::serde_json::values());
  let expected_zdr = value != serde_json::Value::Bool(false);
  let obj = serde_json::json!({ "zeroDataRetention": value });
  let serialized = serde_json::to_string(&obj).unwrap_or_default();
  assert_eq!(pre_parse_zdr_from_json_str(&serialized), expected_zdr);
}
