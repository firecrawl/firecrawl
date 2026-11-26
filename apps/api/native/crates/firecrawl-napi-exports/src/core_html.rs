//! Telemetry-aware N-API wrapper for single-pass `derive_core_html`.

use std::any::Any;

use firecrawl_core_types::{
  CoreNativeError, DeriveCoreHtmlRequest, NativeCallContext, parse_json_input,
};
use firecrawl_telemetry::{
  TraceContext, attach_parent_context, in_zdr_span, init_telemetry, pre_parse_zdr_from_json_str,
  spawn_blocking_in_span,
};
use napi::bindgen_prelude::{Error, Result, Status};
use serde_json::Value;

const ZDR_PANIC_MESSAGE: &str = "panic payload withheld (zero data retention)";

fn core_error_to_napi(err: CoreNativeError) -> Error {
  Error::new(Status::GenericFailure, err.to_transport_string())
}

fn extract_trace_context_hint(context_json: &str) -> Option<TraceContext> {
  let Value::Object(map) = serde_json::from_str::<Value>(context_json).ok()? else {
    return None;
  };
  let traceparent = map
    .get("traceparent")
    .and_then(Value::as_str)
    .map(ToOwned::to_owned);
  let tracestate = map
    .get("tracestate")
    .and_then(Value::as_str)
    .map(ToOwned::to_owned);
  if traceparent.is_none() && tracestate.is_none() {
    return None;
  }
  Some(TraceContext {
    traceparent,
    tracestate,
  })
}

fn format_panic_payload(payload: Box<dyn Any + Send>, is_zdr: bool) -> String {
  if is_zdr || in_zdr_span() {
    return ZDR_PANIC_MESSAGE.to_string();
  }
  if let Some(msg) = payload.downcast_ref::<&str>() {
    (*msg).to_string()
  } else if let Some(msg) = payload.downcast_ref::<String>() {
    msg.clone()
  } else {
    "unknown panic payload".to_string()
  }
}

fn run_catching_panic<F, T>(is_zdr: bool, f: F) -> std::result::Result<T, CoreNativeError>
where
  F: FnOnce() -> std::result::Result<T, CoreNativeError>,
{
  match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
    Ok(Ok(value)) => {
      tracing::Span::current().record("outcome", "ok");
      Ok(value)
    }
    Ok(Err(err)) => {
      tracing::Span::current().record("outcome", "error");
      Err(err)
    }
    Err(payload) => {
      tracing::Span::current().record("outcome", "panic");
      Err(CoreNativeError::Panic {
        message: format_panic_payload(payload, is_zdr),
      })
    }
  }
}

async fn derive_core_html_inner(
  raw_html: String,
  request_json: String,
  context_json: String,
) -> Result<Value> {
  // Inspect ZDR before deserializing either JSON payload so malformed ZDR calls
  // emit zero telemetry.
  let pre_zdr = pre_parse_zdr_from_json_str(&context_json);
  let trace_hint = if pre_zdr {
    None
  } else {
    extract_trace_context_hint(&context_json)
  };

  let span = tracing::info_span!(
    "derive_core_html",
    scrape_id = tracing::field::Empty,
    zero_data_retention = pre_zdr,
    input.argument = tracing::field::Empty,
    input.path = tracing::field::Empty,
    html_len = tracing::field::Empty,
    only_main_content = tracing::field::Empty,
    remove_base64_images = tracing::field::Empty,
    metadata_count = tracing::field::Empty,
    links_count = tracing::field::Empty,
    images_count = tracing::field::Empty,
    attributes_count = tracing::field::Empty,
    outcome = tracing::field::Empty,
  );
  attach_parent_context(&span, trace_hint.as_ref(), pre_zdr);

  let (context, request) =
    span.in_scope(|| -> Result<(NativeCallContext, DeriveCoreHtmlRequest)> {
      let context: NativeCallContext =
        parse_json_input("context", &context_json).map_err(|err| {
          span.record("outcome", "invalid_input");
          core_error_to_napi(err)
        })?;
      if let Some(scrape_id) = context.scrape_id.as_deref() {
        span.record("scrape_id", scrape_id);
      }
      if context.zero_data_retention && !pre_zdr {
        span.record("zero_data_retention", true);
      }

      let request: DeriveCoreHtmlRequest =
        parse_json_input("request", &request_json).map_err(|err| {
          span.record("outcome", "invalid_input");
          core_error_to_napi(err)
        })?;
      span.record("only_main_content", request.only_main_content);
      span.record("remove_base64_images", request.remove_base64_images);
      Ok((context, request))
    })?;

  let is_zdr = pre_zdr || context.zero_data_retention;
  let join_result = spawn_blocking_in_span(span.clone(), move || {
    run_catching_panic(is_zdr, move || {
      firecrawl_html::derive_core_html(&raw_html, &request)
    })
  })
  .await;

  let result = match join_result {
    Ok(Ok(result)) => result,
    Ok(Err(err)) => return Err(core_error_to_napi(err)),
    Err(join_err) => {
      let err = if join_err.is_panic() {
        CoreNativeError::Panic {
          message: if is_zdr {
            ZDR_PANIC_MESSAGE.to_string()
          } else {
            format!("derive_core_html task panicked: {join_err}")
          },
        }
      } else {
        CoreNativeError::Internal {
          message: format!("derive_core_html task failed to complete: {join_err}"),
        }
      };
      return Err(core_error_to_napi(err));
    }
  };

  serde_json::to_value(result).map_err(|err| {
    core_error_to_napi(CoreNativeError::Internal {
      message: format!("failed to serialize DeriveCoreHtmlResult: {err}"),
    })
  })
}

/// Runs single-pass HTML processing with shared telemetry initialization,
/// W3C trace propagation, ZDR suppression, panic catching, and structured
/// `CODE|{json}` error encoding.
pub async fn derive_core_html(
  raw_html: String,
  request_json: String,
  context_json: String,
) -> Result<Value> {
  init_telemetry();
  derive_core_html_inner(raw_html, request_json, context_json).await
}

#[cfg(test)]
mod tests {
  use firecrawl_core_types::CoreNativeFailure;
  use firecrawl_telemetry::{
    ZdrLayer, build_resource, build_zdr_tracer_provider, sampler_from_env,
  };
  use opentelemetry::trace::{TraceId, TracerProvider as _};
  use opentelemetry_sdk::trace::InMemorySpanExporter;
  use tracing::instrument::WithSubscriber;
  use tracing_subscriber::layer::SubscriberExt;

  use super::*;

  fn build_test_subscriber() -> (
    InMemorySpanExporter,
    firecrawl_telemetry::ZdrTracerProvider,
    impl tracing::Subscriber + Send + Sync,
  ) {
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
    (exporter, provider, subscriber)
  }

  #[tokio::test]
  async fn derive_core_html_propagates_w3c_parent_and_suppresses_zdr() {
    let html = "<html><head><title>Test</title></head><body><a href=\"/a\">A</a></body></html>";
    let req = serde_json::json!({
      "url": "https://example.com/page",
      "onlyMainContent": true,
      "includeTags": [],
      "excludeTags": [],
      "needMetadata": true,
      "needLinks": true,
      "needImages": false,
      "removeBase64Images": true
    })
    .to_string();

    let trace_id_hex = "4bf92f3577b34da6a3ce929d0e0e4736";
    let traceparent = format!("00-{trace_id_hex}-00f067aa0ba902b7-01");

    // Non-ZDR exports a span joined to the incoming W3C trace ID.
    {
      let (exporter, provider, subscriber) = build_test_subscriber();
      let ctx = serde_json::json!({
        "traceparent": traceparent,
        "scrapeId": "scrape-non-zdr",
        "zeroDataRetention": false
      })
      .to_string();

      let out = derive_core_html_inner(html.to_string(), req.clone(), ctx)
        .with_subscriber(subscriber)
        .await;
      assert!(out.is_ok(), "expected ok, got {out:?}");
      let _ = provider.force_flush();
      let spans = exporter.get_finished_spans().unwrap_or_default();
      assert_eq!(spans.len(), 1);
      let expected_trace = TraceId::from_hex(trace_id_hex).ok();
      assert_eq!(
        spans.first().map(|s| s.span_context.trace_id()),
        expected_trace
      );
    }

    // ZDR suppresses all spans even with a sampled W3C parent (`-01`).
    {
      let (exporter, provider, subscriber) = build_test_subscriber();
      let ctx = serde_json::json!({
        "traceparent": traceparent,
        "scrapeId": "scrape-zdr",
        "zeroDataRetention": true
      })
      .to_string();

      let out = derive_core_html_inner(html.to_string(), req.clone(), ctx)
        .with_subscriber(subscriber)
        .await;
      assert!(out.is_ok(), "expected ok, got {out:?}");
      let _ = provider.force_flush();
      let spans = exporter.get_finished_spans().unwrap_or_default();
      assert!(spans.is_empty(), "ZDR emitted spans: {spans:?}");
    }

    // Malformed context fails closed as ZDR (0 spans) and returns NATIVE_INVALID_INPUT.
    {
      let (exporter, provider, subscriber) = build_test_subscriber();
      let err = derive_core_html_inner(html.to_string(), req, "{not valid json".to_string())
        .with_subscriber(subscriber)
        .await
        .err();
      let _ = provider.force_flush();
      let spans = exporter.get_finished_spans().unwrap_or_default();
      assert!(spans.is_empty(), "malformed context emitted spans");
      let failure = err
        .as_ref()
        .and_then(|e| CoreNativeFailure::from_transport_string(&e.reason));
      assert!(
        matches!(
          failure,
          Some(CoreNativeFailure::InvalidInput { ref argument, .. }) if argument == "context"
        ),
        "unexpected failure: {failure:?}"
      );
    }
  }

  #[test]
  #[allow(clippy::panic)]
  fn panic_catcher_withholds_payload_under_zdr() {
    let secret_payload = "sensitive customer token 12345";

    let zdr_err = run_catching_panic(true, || -> std::result::Result<(), CoreNativeError> {
      std::panic::panic_any(secret_payload);
    });
    assert_eq!(
      zdr_err,
      Err(CoreNativeError::Panic {
        message: ZDR_PANIC_MESSAGE.to_string(),
      })
    );

    let normal_err = run_catching_panic(false, || -> std::result::Result<(), CoreNativeError> {
      std::panic::panic_any(secret_payload);
    });
    assert_eq!(
      normal_err,
      Err(CoreNativeError::Panic {
        message: secret_payload.to_string(),
      })
    );
  }
}
