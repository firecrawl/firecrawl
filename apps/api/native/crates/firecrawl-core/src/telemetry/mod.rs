//! Shared OpenTelemetry and `tracing` setup for Firecrawl native crates with
//! W3C trace context propagation, `OTEL_TRACES_SAMPLER` parity, and strict
//! zero-data-retention (ZDR) suppression across logs, spans, worker threads,
//! and panic hooks.

use std::{
  io::Write as _,
  sync::{Once, OnceLock},
};

use opentelemetry::trace::TracerProvider as _;
use opentelemetry_otlp::{
  ExporterBuildError, Protocol, RetryPolicy, SpanExporter, WithExportConfig, WithHttpConfig,
};
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::trace::{
  BatchSpanProcessor, Sampler, SdkTracerProvider, SimpleSpanProcessor, SpanExporter as SdkExporter,
  SpanProcessor,
};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::{EnvFilter, Layer, fmt};

mod propagation;
mod scope;
mod zdr;
mod zdr_otel;

#[cfg(test)]
mod properties;
#[cfg(test)]
mod tests;

pub use propagation::{
  TraceContext, attach_parent_context, build_resource, extract_trace_context,
  resource_from_process_env, sampler_from_env, sampler_from_process_env,
};
pub use scope::{
  run_on_scoped_rayon_pool, run_on_scoped_rayon_pool_in_span, spawn_blocking_in_span,
  spawn_blocking_with_span, spawn_thread_with_span,
};
pub use zdr::{
  ZdrContextMarker, ZdrLayer, in_zdr_span, install_zdr_panic_hook, is_zdr_json_value,
  pre_parse_zdr_from_json_str, zdr_span_filter,
};
pub use zdr_otel::{
  ZdrSpan, ZdrTracer, ZdrTracerProvider, ZeroDataRetentionSampler, ZeroDataRetentionSpanProcessor,
};

const TRACER_NAME: &str = "firecrawl-rs";

static INIT: Once = Once::new();
static CRYPTO_PROVIDER_INIT: Once = Once::new();
static PROVIDER: OnceLock<ZdrTracerProvider> = OnceLock::new();

/// Installs the `rustls` ring crypto provider once before any TLS handshake.
pub fn ensure_crypto_provider() {
  CRYPTO_PROVIDER_INIT.call_once(|| {
    let _ = rustls::crypto::ring::default_provider().install_default();
  });
}

/// Resolves the OTLP/HTTP traces endpoint from `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
/// or `OTEL_EXPORTER_OTLP_ENDPOINT` + `/v1/traces`, returning `None` when
/// neither variable is configured.
pub fn traces_endpoint() -> Option<String> {
  if let Ok(endpoint) = std::env::var("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") {
    let trimmed = endpoint.trim();
    if !trimmed.is_empty() {
      return Some(trimmed.to_owned());
    }
  }

  if let Ok(base) = std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT") {
    let trimmed = base.trim();
    if !trimmed.is_empty() {
      return Some(format!("{}/v1/traces", trimmed.trim_end_matches('/')));
    }
  }

  None
}

/// Builds a ZDR-protected [`ZdrTracerProvider`] using a custom [`SpanProcessor`].
pub fn build_tracer_provider_with_processor<P: SpanProcessor + 'static>(
  processor: P,
  resource: Resource,
  delegate_sampler: Sampler,
) -> ZdrTracerProvider {
  build_tracer_provider_with_registry(
    processor,
    resource,
    delegate_sampler,
    zdr_otel::ZdrTraceRegistry::default(),
  )
}

pub(crate) fn build_tracer_provider_with_registry<P: SpanProcessor + 'static>(
  processor: P,
  resource: Resource,
  delegate_sampler: Sampler,
  registry: zdr_otel::ZdrTraceRegistry,
) -> ZdrTracerProvider {
  let provider = SdkTracerProvider::builder()
    .with_sampler(ZeroDataRetentionSampler::with_registry(
      delegate_sampler,
      registry.clone(),
    ))
    .with_span_processor(ZeroDataRetentionSpanProcessor::with_registry(
      processor,
      registry.clone(),
    ))
    .with_resource(resource)
    .build();
  ZdrTracerProvider::new(provider, registry)
}

/// Builds a ZDR-protected [`ZdrTracerProvider`] exporting synchronously via
/// [`SimpleSpanProcessor`], suitable for deterministic in-memory verification.
pub fn build_zdr_tracer_provider<E: SdkExporter + 'static>(
  exporter: E,
  resource: Resource,
  delegate_sampler: Sampler,
) -> ZdrTracerProvider {
  build_tracer_provider_with_processor(
    SimpleSpanProcessor::new(exporter),
    resource,
    delegate_sampler,
  )
}

/// Builds a ZDR-protected [`ZdrTracerProvider`] exporting via
/// [`BatchSpanProcessor`].
pub fn build_batch_zdr_tracer_provider<E: SdkExporter + 'static>(
  exporter: E,
  resource: Resource,
  delegate_sampler: Sampler,
) -> ZdrTracerProvider {
  build_tracer_provider_with_processor(
    BatchSpanProcessor::builder(exporter).build(),
    resource,
    delegate_sampler,
  )
}

fn build_otlp_tracer_provider() -> Option<ZdrTracerProvider> {
  let endpoint = traces_endpoint()?;

  let exporter = match SpanExporter::builder()
    .with_http()
    .with_protocol(Protocol::HttpBinary)
    .with_endpoint(&endpoint)
    // Retries would block flush on every call while the collector is unavailable.
    .with_retry_policy(RetryPolicy::disabled())
    .build()
  {
    Ok(exporter) => exporter,
    Err(err) => {
      let reason = match err {
        ExporterBuildError::InvalidConfiguration(_) => "invalid OTLP configuration",
        ExporterBuildError::InternalFailure(_) => "internal exporter initialization error",
      };
      let _ = writeln!(
        std::io::stderr(),
        "[telemetry] failed to build OTLP exporter: {reason}"
      );
      return None;
    }
  };

  let provider = build_batch_zdr_tracer_provider(
    exporter,
    resource_from_process_env(),
    sampler_from_process_env(),
  );
  Some(provider)
}

fn env_filter() -> EnvFilter {
  EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"))
}

/// Lazily initializes the global tracing subscriber, ZDR panic hook, and
/// (when an OTLP endpoint is configured) the OTLP/HTTP trace exporter.
pub fn init_telemetry() {
  if std::thread::panicking() {
    return;
  }
  INIT.call_once(|| {
    ensure_crypto_provider();
    install_zdr_panic_hook();

    let provider = build_otlp_tracer_provider();
    let otel_layer = provider.as_ref().map(|provider| {
      tracing_opentelemetry::layer()
        .with_tracer(provider.tracer(TRACER_NAME))
        .with_filter(env_filter())
    });

    let zdr_filter = zdr_span_filter(env_filter());

    // Installed even without an exporter so ZdrLayer marks spans for the panic hook.
    let subscriber = tracing_subscriber::registry()
      .with(ZdrLayer.with_filter(zdr_filter))
      .with(
        fmt::layer()
          .with_writer(std::io::stderr)
          .with_filter(env_filter()),
      )
      .with(otel_layer);
    if let Err(err) = tracing::subscriber::set_global_default(subscriber) {
      let _ = writeln!(
        std::io::stderr(),
        "[telemetry] could not install tracing subscriber: {err}"
      );
      return;
    }

    if let Some(provider) = provider {
      opentelemetry::global::set_tracer_provider(provider.clone());
      let _ = PROVIDER.set(provider);
    }
  });
}

/// Flushes any buffered spans out to the configured OTLP collector.
pub fn flush_telemetry() {
  if let Some(provider) = PROVIDER.get() {
    let _ = provider.force_flush();
  }
}

/// Flushes telemetry on drop, including during panic unwinds, so spans
/// produced before a failure are still exported.
#[derive(Debug, Default)]
pub struct FlushGuard;

impl Drop for FlushGuard {
  fn drop(&mut self) {
    flush_telemetry();
  }
}
