//! Zero-data-retention (ZDR) enforcement across tracing layers, OpenTelemetry
//! sampling/export, pre-parse input inspection, and the process panic hook.

use std::collections::{HashSet, VecDeque};
use std::io::Write;
use std::sync::{Arc, Mutex, Once, PoisonError};
use std::time::Duration;

use opentelemetry::trace::{Link, SpanKind, TraceContextExt, TraceId};
use opentelemetry::{Context, KeyValue, Value};
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::error::OTelSdkResult;
use opentelemetry_sdk::trace::{
  Sampler, SamplingDecision, SamplingResult, ShouldSample, Span, SpanData, SpanProcessor,
};
use tracing::field::{Field, Visit};
use tracing::{Event, span};
use tracing_subscriber::filter::{FilterExt, filter_fn};
use tracing_subscriber::layer::Context as LayerContext;
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::{EnvFilter, Layer, Registry};

const ZDR_TRACE_LIMIT: usize = 100_000;
const ZDR_FIELD_NAME: &str = "zero_data_retention";
const ZDR_FIELD_SUFFIX: &str = ".zero_data_retention";

static PANIC_HOOK_INIT: Once = Once::new();

/// Marker stored in a `tracing_subscriber::Registry` span extension when that
/// span or any ancestor belongs to a ZDR operation.
pub(crate) struct ZeroDataRetention;

/// Marker stored in an OpenTelemetry `Context` when the active call is ZDR,
/// guaranteeing the sampler drops spans even if they omit the span attribute.
#[derive(Debug, Clone, Copy)]
pub struct ZdrContextMarker;

#[derive(Debug, Default)]
struct ZdrTraceSet {
  order: VecDeque<TraceId>,
  set: HashSet<TraceId>,
}

/// Bounded FIFO registry of trace IDs flagged as ZDR, mirrored after
/// `apps/api/src/lib/otel-tracer.ts` so child spans and late-flagged spans are
/// dropped even under non-parent-based samplers (`always_on`, `traceidratio`).
#[derive(Debug, Clone, Default)]
pub(crate) struct ZdrTraceRegistry {
  inner: Arc<Mutex<ZdrTraceSet>>,
}

impl ZdrTraceRegistry {
  pub(crate) fn mark(&self, trace_id: TraceId) {
    let mut state = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
    if state.set.insert(trace_id) {
      state.order.push_back(trace_id);
      while state.set.len() > ZDR_TRACE_LIMIT {
        if let Some(oldest) = state.order.pop_front() {
          state.set.remove(&oldest);
        } else {
          break;
        }
      }
    }
  }

  pub(crate) fn contains(&self, trace_id: TraceId) -> bool {
    let state = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
    state.set.contains(&trace_id)
  }
}

fn is_zdr_field(name: &str) -> bool {
  name == ZDR_FIELD_NAME || name.ends_with(ZDR_FIELD_SUFFIX)
}

/// Returns `true` when any ZDR attribute is present with any value other than
/// explicit `false` (fail-closed).
pub(crate) fn has_zdr_attribute(attributes: &[KeyValue]) -> bool {
  attributes
    .iter()
    .any(|kv| is_zdr_field(kv.key.as_str()) && kv.value != Value::Bool(false))
}

struct ZdrFieldVisitor {
  is_zdr: bool,
}

impl Visit for ZdrFieldVisitor {
  fn record_bool(&mut self, field: &Field, value: bool) {
    if is_zdr_field(field.name()) && value {
      self.is_zdr = true;
    }
  }

  fn record_i64(&mut self, field: &Field, _value: i64) {
    if is_zdr_field(field.name()) {
      self.is_zdr = true;
    }
  }

  fn record_u64(&mut self, field: &Field, _value: u64) {
    if is_zdr_field(field.name()) {
      self.is_zdr = true;
    }
  }

  fn record_i128(&mut self, field: &Field, _value: i128) {
    if is_zdr_field(field.name()) {
      self.is_zdr = true;
    }
  }

  fn record_u128(&mut self, field: &Field, _value: u128) {
    if is_zdr_field(field.name()) {
      self.is_zdr = true;
    }
  }

  fn record_f64(&mut self, field: &Field, _value: f64) {
    if is_zdr_field(field.name()) {
      self.is_zdr = true;
    }
  }

  fn record_str(&mut self, field: &Field, _value: &str) {
    if is_zdr_field(field.name()) {
      self.is_zdr = true;
    }
  }

  fn record_bytes(&mut self, field: &Field, _value: &[u8]) {
    if is_zdr_field(field.name()) {
      self.is_zdr = true;
    }
  }

  fn record_error(&mut self, field: &Field, _value: &(dyn std::error::Error + 'static)) {
    if is_zdr_field(field.name()) {
      self.is_zdr = true;
    }
  }

  fn record_debug(&mut self, field: &Field, _value: &dyn std::fmt::Debug) {
    if is_zdr_field(field.name()) {
      self.is_zdr = true;
    }
  }
}

/// Propagates the `zero_data_retention` marker down the span tree and vetoes
/// every log event emitted within a ZDR scope across all subscriber layers.
#[derive(Debug, Clone, Copy, Default)]
pub struct ZdrLayer;

impl<S> Layer<S> for ZdrLayer
where
  S: tracing::Subscriber + for<'a> LookupSpan<'a>,
{
  fn on_new_span(&self, attrs: &span::Attributes<'_>, id: &span::Id, ctx: LayerContext<'_, S>) {
    let Some(span) = ctx.span(id) else {
      return;
    };

    let inherited = span
      .parent()
      .is_some_and(|parent| parent.extensions().get::<ZeroDataRetention>().is_some());

    let mut visitor = ZdrFieldVisitor { is_zdr: false };
    attrs.record(&mut visitor);

    if inherited || visitor.is_zdr {
      span.extensions_mut().insert(ZeroDataRetention);
    }
  }

  fn on_record(&self, id: &span::Id, values: &span::Record<'_>, ctx: LayerContext<'_, S>) {
    let Some(span) = ctx.span(id) else {
      return;
    };

    let mut visitor = ZdrFieldVisitor { is_zdr: false };
    values.record(&mut visitor);

    if visitor.is_zdr {
      span.extensions_mut().replace(ZeroDataRetention);
    }
  }

  fn event_enabled(&self, event: &Event<'_>, ctx: LayerContext<'_, S>) -> bool {
    let in_zdr_scope = ctx
      .event_scope(event)
      .is_some_and(|mut scope| scope.any(|s| s.extensions().get::<ZeroDataRetention>().is_some()));

    !in_zdr_scope
  }
}

/// Filter for [`ZdrLayer`] that keeps `scrape_url` and any span carrying a
/// `zero_data_retention` field active regardless of `RUST_LOG`.
pub fn zdr_span_filter<S>(env_filter: EnvFilter) -> impl tracing_subscriber::layer::Filter<S> {
  env_filter.or(filter_fn(|meta| {
    meta.is_span() && (meta.name() == "scrape_url" || meta.fields().field(ZDR_FIELD_NAME).is_some())
  }))
}

/// Sampler that drops any trace marked as ZDR before consulting its delegate
/// sampler, overriding incoming sampled W3C `traceparent` headers.
#[derive(Debug, Clone)]
pub struct ZeroDataRetentionSampler {
  delegate: Sampler,
  registry: ZdrTraceRegistry,
}

impl ZeroDataRetentionSampler {
  pub fn new(delegate: Sampler) -> Self {
    Self {
      delegate,
      registry: ZdrTraceRegistry::default(),
    }
  }

  pub(crate) fn with_registry(delegate: Sampler, registry: ZdrTraceRegistry) -> Self {
    Self { delegate, registry }
  }
}

impl ShouldSample for ZeroDataRetentionSampler {
  fn should_sample(
    &self,
    parent_context: Option<&Context>,
    trace_id: TraceId,
    name: &str,
    span_kind: &SpanKind,
    attributes: &[KeyValue],
    links: &[Link],
  ) -> SamplingResult {
    let has_zdr_attr = has_zdr_attribute(attributes);
    let has_zdr_ctx = parent_context.is_some_and(|cx| cx.get::<ZdrContextMarker>().is_some());

    if has_zdr_attr || has_zdr_ctx || self.registry.contains(trace_id) {
      self.registry.mark(trace_id);
      return SamplingResult {
        decision: SamplingDecision::Drop,
        attributes: Vec::new(),
        trace_state: parent_context
          .map(|cx| cx.span().span_context().trace_state().clone())
          .unwrap_or_default(),
      };
    }

    self
      .delegate
      .should_sample(parent_context, trace_id, name, span_kind, attributes, links)
  }
}

/// Span processor wrapper that drops any span carrying a ZDR attribute or
/// belonging to a trace flagged as ZDR before it can reach the exporter.
#[derive(Debug)]
pub struct ZeroDataRetentionSpanProcessor<P> {
  delegate: P,
  registry: ZdrTraceRegistry,
}

impl<P> ZeroDataRetentionSpanProcessor<P> {
  pub(crate) fn with_registry(delegate: P, registry: ZdrTraceRegistry) -> Self {
    Self { delegate, registry }
  }
}

impl<P: SpanProcessor> SpanProcessor for ZeroDataRetentionSpanProcessor<P> {
  fn on_start(&self, span: &mut Span, cx: &Context) {
    self.delegate.on_start(span, cx);
  }

  fn on_end(&self, span: SpanData) {
    let trace_id = span.span_context.trace_id();
    if has_zdr_attribute(&span.attributes) {
      self.registry.mark(trace_id);
      return;
    }
    if self.registry.contains(trace_id) {
      return;
    }
    self.delegate.on_end(span);
  }

  fn force_flush(&self) -> OTelSdkResult {
    self.delegate.force_flush()
  }

  fn shutdown_with_timeout(&self, timeout: Duration) -> OTelSdkResult {
    self.delegate.shutdown_with_timeout(timeout)
  }

  fn set_resource(&mut self, resource: &Resource) {
    self.delegate.set_resource(resource);
  }
}

/// Pre-parse ZDR check on an optional JSON value: any value other than explicit
/// `false` counts as ZDR.
pub fn is_zdr_json_value(value: Option<&serde_json::Value>) -> bool {
  value.is_some_and(|v| v != &serde_json::Value::Bool(false))
}

/// Pre-parse ZDR check on a raw JSON payload before typed deserialization so
/// malformed ZDR inputs never emit telemetry. Any value other than `false` for
/// `zeroDataRetention` or `zero_data_retention` counts as ZDR.
pub fn pre_parse_zdr_from_json_str(raw: &str) -> bool {
  match serde_json::from_str::<serde_json::Value>(raw) {
    Ok(serde_json::Value::Object(map)) => {
      is_zdr_json_value(map.get("zeroDataRetention")) || is_zdr_json_value(map.get(ZDR_FIELD_NAME))
    }
    Ok(_) => false,
    Err(_) => raw.contains("zeroDataRetention") || raw.contains(ZDR_FIELD_NAME),
  }
}

/// Returns whether the span currently entered on this thread belongs to a ZDR
/// operation.
pub fn in_zdr_span() -> bool {
  tracing::Span::current()
    .with_subscriber(|(id, dispatch)| {
      dispatch
        .downcast_ref::<Registry>()
        .and_then(|registry| registry.span(id))
        .is_some_and(|span| span.extensions().get::<ZeroDataRetention>().is_some())
    })
    .unwrap_or(false)
}

/// Installs the process panic hook (once) that withholds panic payloads written
/// to stderr when the panicking thread is inside a ZDR span.
pub fn install_zdr_panic_hook() {
  PANIC_HOOK_INIT.call_once(|| {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
      if !in_zdr_span() {
        previous(info);
        return;
      }
      let location = info
        .location()
        .map_or_else(|| "<unknown>".to_string(), ToString::to_string);
      let _ = writeln!(
        std::io::stderr(),
        "panicked at {location}: panic payload withheld (zero data retention)"
      );
    }));
  });
}
