//! Zero-data-retention (ZDR) enforcement across `tracing` layers, pre-parse
//! input inspection, and the process panic hook.

use std::io::Write;
use std::sync::Once;

use opentelemetry::{KeyValue, Value};
use tracing::field::{Field, Visit};
use tracing::{Event, span};
use tracing_subscriber::filter::{FilterExt, filter_fn};
use tracing_subscriber::layer::Context as LayerContext;
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::{EnvFilter, Layer, Registry};

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

pub(crate) fn is_zdr_field(name: &str) -> bool {
  name == ZDR_FIELD_NAME || name.ends_with(ZDR_FIELD_SUFFIX)
}

/// Returns `true` when `kv` is a ZDR attribute with any value other than
/// explicit `false` (fail-closed).
pub(crate) fn is_zdr_kv(kv: &KeyValue) -> bool {
  is_zdr_field(kv.key.as_str()) && kv.value != Value::Bool(false)
}

/// Returns `true` when any ZDR attribute is present with any value other than
/// explicit `false` (fail-closed).
pub(crate) fn has_zdr_attribute(attributes: &[KeyValue]) -> bool {
  attributes.iter().any(is_zdr_kv)
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
/// every log event emitted within a ZDR scope or carrying a ZDR field across
/// all subscriber layers.
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
      .scope()
      .skip(1)
      .any(|ancestor| ancestor.extensions().get::<ZeroDataRetention>().is_some());

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
    let mut visitor = ZdrFieldVisitor { is_zdr: false };
    event.record(&mut visitor);
    if visitor.is_zdr {
      return false;
    }

    let in_zdr_scope = ctx
      .event_scope(event)
      .is_some_and(|mut scope| scope.any(|s| s.extensions().get::<ZeroDataRetention>().is_some()));

    !in_zdr_scope
  }
}

/// Filter for [`ZdrLayer`] that keeps `scrape_url` spans and any span or event
/// carrying a `zero_data_retention` (or `*.zero_data_retention`) field active
/// regardless of `RUST_LOG`.
pub fn zdr_span_filter<S>(env_filter: EnvFilter) -> impl tracing_subscriber::layer::Filter<S> {
  env_filter.or(filter_fn(|meta| {
    (meta.is_span() && meta.name() == "scrape_url")
      || meta.fields().iter().any(|field| is_zdr_field(field.name()))
  }))
}

/// Pre-parse ZDR check on an optional JSON value: any value other than explicit
/// `false` counts as ZDR.
pub fn is_zdr_json_value(value: Option<&serde_json::Value>) -> bool {
  value.is_some_and(|v| v != &serde_json::Value::Bool(false))
}

/// Pre-parse ZDR check on a raw JSON payload before typed deserialization so
/// malformed ZDR inputs never emit telemetry. Any value other than `false` for
/// `zeroDataRetention` or `zero_data_retention`, and any JSON parse failure,
/// fails closed as ZDR (`true`).
pub fn pre_parse_zdr_from_json_str(raw: &str) -> bool {
  match serde_json::from_str::<serde_json::Value>(raw) {
    Ok(serde_json::Value::Object(map)) => {
      is_zdr_json_value(map.get("zeroDataRetention")) || is_zdr_json_value(map.get(ZDR_FIELD_NAME))
    }
    Ok(_) => false,
    Err(_) => true,
  }
}

/// Returns whether the span currently entered on this thread (or any ancestor)
/// belongs to a ZDR operation.
pub fn in_zdr_span() -> bool {
  tracing::Span::current()
    .with_subscriber(|(id, dispatch)| {
      dispatch
        .downcast_ref::<Registry>()
        .and_then(|registry| registry.span(id))
        .is_some_and(|span| {
          span
            .scope()
            .any(|s| s.extensions().get::<ZeroDataRetention>().is_some())
        })
    })
    .unwrap_or(false)
}

/// Installs the process panic hook (once) that withholds panic payloads written
/// to stderr when the panicking thread is inside a ZDR span. Calls during a
/// panic leave installation to a later call.
pub fn install_zdr_panic_hook() {
  if std::thread::panicking() {
    return;
  }
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
