//! OpenTelemetry SDK zero-data-retention (ZDR) enforcement: active-trace
//! registry, sampler with fail-closed `TraceState` descendant propagation,
//! span processor, and `TracerProvider`/`Tracer`/`Span` wrappers that record
//! late ZDR attributes immediately instead of waiting for `on_end`.

use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, SystemTime};

use opentelemetry::trace::{
  Link, Span as SpanTrait, SpanBuilder, SpanContext, SpanKind, Status, TraceContextExt, TraceId,
  TraceState, Tracer, TracerProvider,
};
use opentelemetry::{Context, InstrumentationScope, KeyValue};
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::error::OTelSdkResult;
use opentelemetry_sdk::trace::{
  Sampler, SamplingDecision, SamplingResult, SdkTracer, SdkTracerProvider, ShouldSample,
  Span as SdkSpan, SpanData, SpanProcessor,
};

use crate::zdr::{ZdrContextMarker, has_zdr_attribute, is_zdr_kv};

const ZDR_TRACE_LIMIT: usize = 100_000;
const ZDR_TRACESTATE_KEY: &str = "firecrawl_zdr";

#[derive(Debug)]
struct ZdrTraceSet {
  completed_limit: usize,
  next_seq: u64,
  active_spans: HashMap<TraceId, usize>,
  active_zdr: HashSet<TraceId>,
  completed_seq: HashMap<TraceId, u64>,
  completed_by_seq: BTreeMap<u64, TraceId>,
}

impl ZdrTraceSet {
  fn with_limit(completed_limit: usize) -> Self {
    Self {
      completed_limit,
      next_seq: 0,
      active_spans: HashMap::new(),
      active_zdr: HashSet::new(),
      completed_seq: HashMap::new(),
      completed_by_seq: BTreeMap::new(),
    }
  }

  fn remove_completed(&mut self, trace_id: &TraceId) -> bool {
    if let Some(seq) = self.completed_seq.remove(trace_id) {
      self.completed_by_seq.remove(&seq);
      return true;
    }
    false
  }

  fn push_completed(&mut self, trace_id: TraceId) {
    if self.completed_limit == 0 || self.completed_seq.contains_key(&trace_id) {
      return;
    }
    let seq = self.next_seq;
    self.next_seq = self.next_seq.wrapping_add(1);
    self.completed_seq.insert(trace_id, seq);
    self.completed_by_seq.insert(seq, trace_id);
    while self.completed_seq.len() > self.completed_limit {
      let Some((_, oldest)) = self.completed_by_seq.pop_first() else {
        break;
      };
      self.completed_seq.remove(&oldest);
    }
  }
}

impl Default for ZdrTraceSet {
  fn default() -> Self {
    Self::with_limit(ZDR_TRACE_LIMIT)
  }
}

/// Registry of trace IDs flagged as ZDR. Active traces with open spans are
/// retained unconditionally until their final span ends; completed traces are
/// retained in a bounded FIFO so late or out-of-order spans are still dropped.
#[derive(Debug, Clone, Default)]
pub(crate) struct ZdrTraceRegistry {
  inner: Arc<Mutex<ZdrTraceSet>>,
}

impl ZdrTraceRegistry {
  #[cfg(test)]
  pub(crate) fn with_limit(completed_limit: usize) -> Self {
    Self {
      inner: Arc::new(Mutex::new(ZdrTraceSet::with_limit(completed_limit))),
    }
  }

  #[cfg(test)]
  pub(crate) fn completed_counts(&self) -> (usize, usize) {
    let state = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
    (state.completed_seq.len(), state.completed_by_seq.len())
  }

  pub(crate) fn on_span_start(&self, trace_id: TraceId) {
    let mut state = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
    let count = state.active_spans.entry(trace_id).or_insert(0);
    *count = count.saturating_add(1);
    if state.remove_completed(&trace_id) {
      state.active_zdr.insert(trace_id);
    }
  }

  pub(crate) fn mark(&self, trace_id: TraceId) {
    let mut state = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
    if state.active_spans.contains_key(&trace_id) {
      state.active_zdr.insert(trace_id);
      state.remove_completed(&trace_id);
    } else if !state.active_zdr.contains(&trace_id) {
      state.push_completed(trace_id);
    }
  }

  pub(crate) fn on_span_end(&self, trace_id: TraceId, is_zdr_span: bool) -> bool {
    let mut state = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
    if is_zdr_span {
      state.active_zdr.insert(trace_id);
      state.remove_completed(&trace_id);
    }

    let drop_span =
      state.active_zdr.contains(&trace_id) || state.completed_seq.contains_key(&trace_id);

    let remaining = match state.active_spans.get_mut(&trace_id) {
      Some(count) if *count > 1 => {
        *count = count.saturating_sub(1);
        *count
      }
      Some(_) => {
        state.active_spans.remove(&trace_id);
        0
      }
      None => 0,
    };

    if remaining == 0 && state.active_zdr.remove(&trace_id) {
      state.push_completed(trace_id);
    }

    drop_span
  }

  pub(crate) fn contains(&self, trace_id: TraceId) -> bool {
    let state = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
    state.active_zdr.contains(&trace_id) || state.completed_seq.contains_key(&trace_id)
  }
}

/// Sampler that drops any trace marked as ZDR before consulting its delegate
/// sampler, overriding incoming sampled W3C `traceparent` headers and tagging
/// dropped spans' `TraceState` with a fail-closed descendant marker.
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
    let has_zdr_tracestate = parent_context.is_some_and(|cx| {
      cx.span()
        .span_context()
        .trace_state()
        .get(ZDR_TRACESTATE_KEY)
        .is_some()
    });

    if has_zdr_attr || has_zdr_ctx || has_zdr_tracestate || self.registry.contains(trace_id) {
      self.registry.mark(trace_id);
      let base_state = parent_context
        .map(|cx| cx.span().span_context().trace_state().clone())
        .unwrap_or_default();
      // Dropped spans are never exported; if base_state is at its 32-entry W3C
      // limit, replace it with the fail-closed descendant marker alone.
      let trace_state = base_state
        .insert(ZDR_TRACESTATE_KEY, "1")
        .or_else(|_| TraceState::from_key_value([(ZDR_TRACESTATE_KEY, "1")]))
        .unwrap_or_default();
      return SamplingResult {
        decision: SamplingDecision::Drop,
        attributes: Vec::new(),
        trace_state,
      };
    }

    self
      .delegate
      .should_sample(parent_context, trace_id, name, span_kind, attributes, links)
  }
}

/// Span processor wrapper that tracks active traces and drops any span carrying
/// a ZDR attribute or belonging to a trace flagged as ZDR before export.
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
  fn on_start(&self, span: &mut SdkSpan, cx: &Context) {
    self.registry.on_span_start(span.span_context().trace_id());
    self.delegate.on_start(span, cx);
  }

  fn on_end(&self, span: SpanData) {
    let trace_id = span.span_context.trace_id();
    let is_zdr_span = has_zdr_attribute(&span.attributes);
    if self.registry.on_span_end(trace_id, is_zdr_span) {
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

/// OpenTelemetry [`TracerProvider`] wrapper pairing [`SdkTracerProvider`] with
/// the shared [`ZdrTraceRegistry`] so late ZDR attributes on live spans take
/// effect immediately instead of waiting for `on_end`.
#[derive(Debug, Clone)]
pub struct ZdrTracerProvider {
  inner: SdkTracerProvider,
  registry: ZdrTraceRegistry,
}

impl ZdrTracerProvider {
  pub(crate) fn new(inner: SdkTracerProvider, registry: ZdrTraceRegistry) -> Self {
    Self { inner, registry }
  }

  /// Flushes all pending spans in the underlying SDK tracer provider.
  pub fn force_flush(&self) -> OTelSdkResult {
    self.inner.force_flush()
  }

  /// Shuts down the underlying SDK tracer provider with its default timeout.
  pub fn shutdown(&self) -> OTelSdkResult {
    self.inner.shutdown()
  }

  /// Shuts down the underlying SDK tracer provider with a bounded timeout.
  pub fn shutdown_with_timeout(&self, timeout: Duration) -> OTelSdkResult {
    self.inner.shutdown_with_timeout(timeout)
  }
}

impl TracerProvider for ZdrTracerProvider {
  type Tracer = ZdrTracer;

  fn tracer_with_scope(&self, scope: InstrumentationScope) -> Self::Tracer {
    ZdrTracer {
      inner: self.inner.tracer_with_scope(scope),
      registry: self.registry.clone(),
    }
  }
}

/// OpenTelemetry [`Tracer`] wrapper producing [`ZdrSpan`] instances linked to
/// the provider's [`ZdrTraceRegistry`].
#[derive(Debug, Clone)]
pub struct ZdrTracer {
  inner: SdkTracer,
  registry: ZdrTraceRegistry,
}

impl Tracer for ZdrTracer {
  type Span = ZdrSpan;

  fn build_with_context(&self, builder: SpanBuilder, parent_cx: &Context) -> Self::Span {
    ZdrSpan {
      inner: self.inner.build_with_context(builder, parent_cx),
      registry: self.registry.clone(),
    }
  }
}

/// OpenTelemetry [`Span`] wrapper that flags the span's trace ID in
/// [`ZdrTraceRegistry`] as soon as a ZDR attribute is set via `set_attribute`
/// or `set_attributes`.
#[derive(Debug)]
pub struct ZdrSpan {
  inner: SdkSpan,
  registry: ZdrTraceRegistry,
}

impl SpanTrait for ZdrSpan {
  fn add_event_with_timestamp<T>(
    &mut self,
    name: T,
    timestamp: SystemTime,
    attributes: Vec<KeyValue>,
  ) where
    T: Into<Cow<'static, str>>,
  {
    self
      .inner
      .add_event_with_timestamp(name, timestamp, attributes);
  }

  fn span_context(&self) -> &SpanContext {
    self.inner.span_context()
  }

  fn is_recording(&self) -> bool {
    self.inner.is_recording()
  }

  fn set_attribute(&mut self, attribute: KeyValue) {
    if is_zdr_kv(&attribute) {
      self.registry.mark(self.inner.span_context().trace_id());
    }
    self.inner.set_attribute(attribute);
  }

  fn set_attributes(&mut self, attributes: impl IntoIterator<Item = KeyValue>) {
    let attrs: Vec<KeyValue> = attributes.into_iter().collect();
    if has_zdr_attribute(&attrs) {
      self.registry.mark(self.inner.span_context().trace_id());
    }
    self.inner.set_attributes(attrs);
  }

  fn set_status(&mut self, status: Status) {
    self.inner.set_status(status);
  }

  fn update_name<T>(&mut self, new_name: T)
  where
    T: Into<Cow<'static, str>>,
  {
    self.inner.update_name(new_name);
  }

  fn add_link(&mut self, span_context: SpanContext, attributes: Vec<KeyValue>) {
    self.inner.add_link(span_context, attributes);
  }

  fn end_with_timestamp(&mut self, timestamp: SystemTime) {
    self.inner.end_with_timestamp(timestamp);
  }
}
