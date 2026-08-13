//! Wires the crate's `tracing` instrumentation to an OTLP/HTTP collector
//! (e.g. otel-desktop-viewer). Initialized lazily on the first scrape so the
//! process only builds an exporter when it actually runs work.

use std::sync::{Once, OnceLock};

use opentelemetry::trace::{
  Link, SpanKind, TraceContextExt, TraceId, TraceState, TracerProvider as _,
};
use opentelemetry::{Context, KeyValue, Value};
use opentelemetry_otlp::{Protocol, SpanExporter, WithExportConfig};
use opentelemetry_sdk::trace::{Sampler, SamplingDecision, SamplingResult, ShouldSample};
use opentelemetry_sdk::{Resource, trace::SdkTracerProvider};
use tracing::field::{Field, Visit};
use tracing::{Event, span};
use tracing_subscriber::Layer;
use tracing_subscriber::layer::Context as LayerContext;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, fmt};

/// Marker stored in a span's extensions when that span -- or any ancestor -- is
/// a zero-data-retention scrape. Inserted at span creation and inherited from
/// the parent, so it covers the entire subtree under a ZDR `scrape_url` span.
struct ZeroDataRetention;

struct ZdrFieldVisitor {
  is_zdr: bool,
}

impl Visit for ZdrFieldVisitor {
  fn record_bool(&mut self, field: &Field, value: bool) {
    if field.name() == "zero_data_retention" && value {
      self.is_zdr = true;
    }
  }

  fn record_debug(&mut self, _field: &Field, _value: &dyn std::fmt::Debug) {}
}

/// Propagates the `zero_data_retention` flag down the span tree and drops every
/// log event emitted within a ZDR scrape. `event_enabled` is a global veto in a
/// layered subscriber, so a dropped event never reaches any sink -- console,
/// OTLP span-events, or a future logs exporter.
struct ZdrLayer;

impl<S> Layer<S> for ZdrLayer
where
  S: tracing::Subscriber + for<'a> LookupSpan<'a>,
{
  fn on_new_span(&self, attrs: &span::Attributes<'_>, id: &span::Id, ctx: LayerContext<'_, S>) {
    let Some(span) = ctx.span(id) else {
      return;
    };

    // Inherit the flag from the parent (this is the propagation), ...
    let inherited = span
      .parent()
      .map(|parent| parent.extensions().get::<ZeroDataRetention>().is_some())
      .unwrap_or(false);

    // ... or set it if this span itself is flagged `zero_data_retention = true`.
    let mut visitor = ZdrFieldVisitor { is_zdr: false };
    attrs.record(&mut visitor);

    if inherited || visitor.is_zdr {
      span.extensions_mut().insert(ZeroDataRetention);
    }
  }

  fn event_enabled(&self, event: &Event<'_>, ctx: LayerContext<'_, S>) -> bool {
    let in_zdr_scope = ctx
      .event_scope(event)
      .map(|mut scope| scope.any(|span| span.extensions().get::<ZeroDataRetention>().is_some()))
      .unwrap_or(false);

    // false = drop the event entirely (never recorded by any layer).
    !in_zdr_scope
  }
}

/// Sampler that never records a trace whose root span is flagged
/// `zero_data_retention = true`. The decision is made at span creation, so a ZDR
/// span (and, via the parent-based delegate, every child span in its trace) is
/// dropped before any span data is recorded, buffered, or exported -- nothing
/// about a ZDR scrape ever reaches the collector.
#[derive(Debug, Clone)]
struct ZeroDataRetentionSampler {
  delegate: Sampler,
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
    let zero_data_retention = attributes
      .iter()
      .any(|kv| kv.key.as_str() == "zero_data_retention" && kv.value == Value::Bool(true));

    if zero_data_retention {
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

static INIT: Once = Once::new();
static PROVIDER: OnceLock<SdkTracerProvider> = OnceLock::new();

/// Resolve the traces endpoint from the standard OTEL env vars, falling back to
/// the local otel-desktop-viewer default. `OTEL_EXPORTER_OTLP_ENDPOINT` is a
/// base URL to which the `/v1/traces` signal path is appended.
fn traces_endpoint() -> String {
  if let Ok(e) = std::env::var("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")
    && !e.is_empty()
  {
    return e;
  }

  let base = std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT")
    .ok()
    .filter(|s| !s.is_empty())
    .unwrap_or_else(|| "http://localhost:4318".to_string());

  format!("{}/v1/traces", base.trim_end_matches('/'))
}

pub fn init_telemetry() {
  INIT.call_once(|| {
    let endpoint = traces_endpoint();

    let exporter = match SpanExporter::builder()
      .with_http()
      .with_protocol(Protocol::HttpBinary)
      .with_endpoint(&endpoint)
      .build()
    {
      Ok(exporter) => exporter,
      Err(e) => {
        eprintln!("[telemetry] failed to build OTLP exporter ({endpoint}): {e}");
        return;
      }
    };

    let provider = SdkTracerProvider::builder()
      .with_sampler(ZeroDataRetentionSampler {
        // Root spans without the ZDR flag are always recorded; child spans
        // follow their parent's decision (so a dropped ZDR root drops its tree).
        delegate: Sampler::ParentBased(Box::new(Sampler::AlwaysOn)),
      })
      .with_batch_exporter(exporter)
      .with_resource(
        Resource::builder()
          .with_service_name("firecrawl-rs")
          .build(),
      )
      .build();

    let tracer = provider.tracer("firecrawl-rs");
    opentelemetry::global::set_tracer_provider(provider.clone());
    let _ = PROVIDER.set(provider);

    let filter =
      EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    let _ = tracing_subscriber::registry()
      .with(filter)
      // Marks ZDR spans and vetoes ZDR log events for every downstream layer.
      .with(ZdrLayer)
      .with(fmt::layer().with_writer(std::io::stderr))
      .with(tracing_opentelemetry::layer().with_tracer(tracer))
      .try_init();

    eprintln!("[telemetry] OTLP traces -> {endpoint}");
  });
}

/// Force any buffered spans out to the collector. Called after a scrape so
/// short-lived processes (e.g. a one-shot node script) don't exit before the
/// batch processor flushes.
pub fn flush_telemetry() {
  if let Some(provider) = PROVIDER.get() {
    let _ = provider.force_flush();
  }
}

/// Flushes telemetry on drop, including during a panic unwind, so a scrape that
/// panics mid-flight still exports the spans it produced (which is exactly when
/// the trace is most useful).
pub struct FlushGuard;

impl Drop for FlushGuard {
  fn drop(&mut self) {
    flush_telemetry();
  }
}
