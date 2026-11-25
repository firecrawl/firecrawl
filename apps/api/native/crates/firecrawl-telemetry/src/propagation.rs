//! W3C trace context ingestion, `OTEL_TRACES_SAMPLER` parsing, and resource
//! construction matching `apps/api/src/lib/otel-tracer.ts`.

use opentelemetry::propagation::{Extractor, TextMapPropagator};
use opentelemetry::trace::TraceContextExt;
use opentelemetry::{Context, KeyValue};
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::propagation::TraceContextPropagator;
use opentelemetry_sdk::trace::Sampler;
use tracing_opentelemetry::OpenTelemetrySpanExt;

use crate::zdr::ZdrContextMarker;

const DEFAULT_SERVICE_NAME: &str = "firecrawl-rs";

/// W3C trace context carrier matching `serializeTraceContext()` in
/// `apps/api/src/lib/otel-tracer.ts`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TraceContext {
  pub traceparent: Option<String>,
  pub tracestate: Option<String>,
}

impl Extractor for TraceContext {
  fn get(&self, key: &str) -> Option<&str> {
    if key.eq_ignore_ascii_case("traceparent") {
      self.traceparent.as_deref()
    } else if key.eq_ignore_ascii_case("tracestate") {
      self.tracestate.as_deref()
    } else {
      None
    }
  }

  fn keys(&self) -> Vec<&str> {
    let mut out = Vec::with_capacity(2);
    if self.traceparent.is_some() {
      out.push("traceparent");
    }
    if self.tracestate.is_some() {
      out.push("tracestate");
    }
    out
  }
}

/// Extracts a valid W3C remote parent context from `ctx`, returning `None` if
/// `traceparent` is missing or malformed.
pub fn extract_trace_context(ctx: &TraceContext) -> Option<Context> {
  if ctx.traceparent.as_deref().is_none_or(str::is_empty) {
    return None;
  }
  let extracted = TraceContextPropagator::new().extract(ctx);
  extracted
    .span()
    .span_context()
    .is_valid()
    .then_some(extracted)
}

/// Attaches an incoming W3C trace context as the parent of `span`. When
/// `zero_data_retention` is `true`, ZDR overrides any incoming sampled
/// `traceparent` and attaches a ZDR-marked context instead.
pub fn attach_parent_context(
  span: &tracing::Span,
  trace_context: Option<&TraceContext>,
  zero_data_retention: bool,
) {
  if zero_data_retention {
    let _ = span.set_parent(Context::new().with_value(ZdrContextMarker));
    return;
  }

  if let Some(parent_cx) = trace_context.and_then(extract_trace_context) {
    let _ = span.set_parent(parent_cx);
  }
}

/// Builds the OpenTelemetry sampler named by `OTEL_TRACES_SAMPLER` and
/// `OTEL_TRACES_SAMPLER_ARG`, matching `samplerFromEnv` in
/// `apps/api/src/lib/otel-tracer.ts`. Unknown or unset names default to
/// `parentbased_always_on`; missing or invalid ratios default to `1.0`.
pub fn sampler_from_env(name: Option<&str>, arg: Option<&str>) -> Sampler {
  let trimmed_arg = arg.map(str::trim).filter(|s| !s.is_empty());
  let ratio = match trimmed_arg {
    Some(raw) => match raw.parse::<f64>() {
      Ok(val) if val.is_finite() && (0.0..=1.0).contains(&val) => val,
      _ => {
        eprintln!("[telemetry] invalid OTEL_TRACES_SAMPLER_ARG \"{raw}\", using 1");
        1.0
      }
    },
    None => 1.0,
  };

  let normalized = name.map(|s| s.trim().to_ascii_lowercase());
  match normalized.as_deref() {
    Some("always_on") => Sampler::AlwaysOn,
    Some("always_off") => Sampler::AlwaysOff,
    Some("traceidratio") => Sampler::TraceIdRatioBased(ratio),
    Some("parentbased_always_off") => Sampler::ParentBased(Box::new(Sampler::AlwaysOff)),
    Some("parentbased_traceidratio") => {
      Sampler::ParentBased(Box::new(Sampler::TraceIdRatioBased(ratio)))
    }
    Some("parentbased_always_on") | Some("") | None => {
      Sampler::ParentBased(Box::new(Sampler::AlwaysOn))
    }
    Some(other) => {
      eprintln!("[telemetry] unknown OTEL_TRACES_SAMPLER \"{other}\", using parentbased_always_on");
      Sampler::ParentBased(Box::new(Sampler::AlwaysOn))
    }
  }
}

/// Reads `OTEL_TRACES_SAMPLER` and `OTEL_TRACES_SAMPLER_ARG` from the process
/// environment.
pub fn sampler_from_process_env() -> Sampler {
  let name = std::env::var("OTEL_TRACES_SAMPLER").ok();
  let arg = std::env::var("OTEL_TRACES_SAMPLER_ARG").ok();
  sampler_from_env(name.as_deref(), arg.as_deref())
}

/// Builds an OpenTelemetry [`Resource`] honoring `service.name` and optional
/// `service.instance.id`.
pub fn build_resource(service_name: Option<&str>, service_instance_id: Option<&str>) -> Resource {
  let resolved_name = service_name
    .map(str::trim)
    .filter(|s| !s.is_empty())
    .unwrap_or(DEFAULT_SERVICE_NAME)
    .to_owned();

  let mut builder = Resource::builder().with_service_name(resolved_name);
  if let Some(instance_id) = service_instance_id.map(str::trim).filter(|s| !s.is_empty()) {
    builder = builder.with_attribute(KeyValue::new("service.instance.id", instance_id.to_owned()));
  }
  builder.build()
}

/// Reads `OTEL_SERVICE_NAME` and `NUQ_POD_NAME` from the process environment.
pub fn resource_from_process_env() -> Resource {
  let service_name = std::env::var("OTEL_SERVICE_NAME").ok();
  let pod_name = std::env::var("NUQ_POD_NAME").ok();
  build_resource(service_name.as_deref(), pod_name.as_deref())
}
