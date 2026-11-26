//! NAPI boundary entrypoint for `parse_raw_document` with W3C trace context
//! propagation, fail-closed ZDR enforcement, and `CODE|{json}` error transport.

use firecrawl_core_types::{
  CoreNativeError, NativeCallContext, ParseRawDocumentRequest, parse_json_input,
};
use firecrawl_telemetry::{
  TraceContext, attach_parent_context, init_telemetry, pre_parse_zdr_from_json_str,
  spawn_blocking_in_span,
};
use napi::bindgen_prelude::{Buffer, Error, Result, Status};
use tracing::field::Empty;

const ZDR_PANIC_MESSAGE: &str = "native task panicked (details withheld under zero data retention)";

fn core_error_to_napi(err: CoreNativeError) -> Error {
  Error::new(Status::GenericFailure, err.to_transport_string())
}

fn format_panic_payload(payload: Box<dyn std::any::Any + Send>, zdr: bool) -> CoreNativeError {
  if zdr {
    return CoreNativeError::Panic {
      message: ZDR_PANIC_MESSAGE.to_string(),
    };
  }
  let message = if let Some(msg) = payload.downcast_ref::<&str>() {
    (*msg).to_string()
  } else if let Some(msg) = payload.downcast_ref::<String>() {
    msg.clone()
  } else {
    "native task panicked".to_string()
  };
  CoreNativeError::Panic { message }
}

/// Parses raw document bytes off the Node.js event loop using the pure-Rust
/// `firecrawl-parsers::parse_raw_document` pipeline, propagating W3C trace
/// context and enforcing fail-closed ZDR suppression across blocking and rayon
/// worker threads.
pub async fn parse_raw_document(
  raw_bytes: Buffer,
  request_json: String,
  context_json: String,
) -> Result<String> {
  init_telemetry();

  // Fail-closed ZDR detection before deserializing context JSON so malformed
  // inputs still suppress span export, event logging, and panic payloads.
  let pre_parse_zdr = pre_parse_zdr_from_json_str(&context_json);
  let span = tracing::info_span!(
    "native.parse_raw_document",
    zero_data_retention = pre_parse_zdr,
    scrape_id = Empty,
    input.argument = Empty,
    input.path = Empty,
    parser = Empty,
  );
  if pre_parse_zdr {
    attach_parent_context(&span, None, true);
  }

  let (request, zdr) = span.in_scope(|| -> Result<(ParseRawDocumentRequest, bool)> {
    let call_ctx: NativeCallContext =
      parse_json_input("contextJson", &context_json).map_err(core_error_to_napi)?;
    let zdr = pre_parse_zdr || call_ctx.zero_data_retention;
    if zdr {
      span.record("zero_data_retention", true);
    }
    if let Some(scrape_id) = call_ctx.scrape_id.as_deref() {
      span.record("scrape_id", scrape_id);
    }
    let trace_ctx = TraceContext {
      traceparent: call_ctx.traceparent,
      tracestate: call_ctx.tracestate,
    };
    attach_parent_context(&span, Some(&trace_ctx), zdr);

    let request: ParseRawDocumentRequest =
      parse_json_input("requestJson", &request_json).map_err(core_error_to_napi)?;
    Ok((request, zdr))
  })?;

  // Enforce maxFileSizeBytes before copying bytes out of the JS Buffer so
  // oversized inputs fail in O(1) without allocating a duplicate buffer.
  if let Some(limit) = request.max_file_size_bytes {
    let actual = u64::try_from(raw_bytes.len()).unwrap_or(u64::MAX);
    if actual > limit {
      return Err(core_error_to_napi(CoreNativeError::UnsupportedFile {
        reason: format!("File exceeds size limit ({actual} > {limit} bytes)"),
      }));
    }
  }

  let owned_bytes = raw_bytes.as_ref().to_vec();
  drop(raw_bytes);

  let parsed = spawn_blocking_in_span(span.clone(), move || {
    firecrawl_parsers::parse_raw_document(&owned_bytes, &request)
  })
  .await
  .map_err(|join_err| {
    if join_err.is_panic() {
      core_error_to_napi(format_panic_payload(join_err.into_panic(), zdr))
    } else {
      core_error_to_napi(CoreNativeError::Internal {
        message: format!("parse_raw_document task failed: {join_err}"),
      })
    }
  })?
  .map_err(core_error_to_napi)?;

  span.record("parser", parsed.parser.to_string().as_str());

  serde_json::to_string(&parsed).map_err(|err| {
    core_error_to_napi(CoreNativeError::Internal {
      message: format!("failed to serialize ParseRawDocumentResult: {err}"),
    })
  })
}
