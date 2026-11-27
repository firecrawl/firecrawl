use std::sync::{Arc, Mutex, PoisonError};

use hegel::{TestCase, generators as gs};
use serde_json::{Value, json};
use tracing::field::{Field, Visit};
use tracing::span;
use tracing_subscriber::Layer;
use tracing_subscriber::layer::{Context as LayerContext, SubscriberExt};

use super::{
  CoreNativeError, CoreNativeFailure, CoreParserKind, CoreParsers, CorePdfType,
  DeriveCoreHtmlRequest, NativeCallContext, ParseRawDocumentRequest, parse_json_input,
};

#[derive(Debug, Default, Clone)]
struct RecordedFields {
  argument: Option<String>,
  path: Option<String>,
}

struct InputFieldVisitor {
  argument: Option<String>,
  path: Option<String>,
}

impl Visit for InputFieldVisitor {
  fn record_str(&mut self, field: &Field, value: &str) {
    if field.name() == "input.argument" {
      self.argument = Some(value.to_string());
    } else if field.name() == "input.path" {
      self.path = Some(value.to_string());
    }
  }

  fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
    if field.name() == "input.argument" {
      self.argument = Some(format!("{value:?}"));
    } else if field.name() == "input.path" {
      self.path = Some(format!("{value:?}"));
    }
  }
}

struct InputCaptureLayer {
  recorded: Arc<Mutex<RecordedFields>>,
}

impl<S> Layer<S> for InputCaptureLayer
where
  S: tracing::Subscriber + for<'a> tracing_subscriber::registry::LookupSpan<'a>,
{
  fn on_record(&self, _id: &span::Id, values: &span::Record<'_>, _ctx: LayerContext<'_, S>) {
    let mut visitor = InputFieldVisitor {
      argument: None,
      path: None,
    };
    values.record(&mut visitor);
    let mut state = self.recorded.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(arg) = visitor.argument {
      state.argument = Some(arg);
    }
    if let Some(path) = visitor.path {
      state.path = Some(path);
    }
  }
}

#[hegel::composite]
fn core_parser_kind(tc: &TestCase) -> CoreParserKind {
  tc.draw(gs::sampled_from(&[
    CoreParserKind::Pdf,
    CoreParserKind::Document,
    CoreParserKind::Fallback,
    CoreParserKind::RawBase64,
  ]))
}

#[hegel::composite]
fn core_pdf_type(tc: &TestCase) -> CorePdfType {
  tc.draw(gs::sampled_from(&[
    CorePdfType::TextBased,
    CorePdfType::Scanned,
    CorePdfType::ImageBased,
    CorePdfType::Mixed,
  ]))
}

#[hegel::composite]
fn core_native_error(tc: &TestCase) -> CoreNativeError {
  let text = || gs::text().max_size(64);
  match tc.draw(gs::integers::<u8>().max_value(7)) {
    0 => CoreNativeError::InvalidInput {
      argument: tc.draw(text()),
      path: tc.draw(text()),
      message: tc.draw(text()),
    },
    1 => CoreNativeError::UnsupportedFile {
      reason: tc.draw(text()),
    },
    2 => CoreNativeError::PdfOcrRequired {
      pdf_type: tc.draw(core_pdf_type()),
    },
    3 => CoreNativeError::PdfInsufficientTime {
      page_count: tc.draw(gs::integers::<u32>()),
      min_timeout: tc.draw(gs::integers::<u64>()),
    },
    4 => CoreNativeError::HtmlProcessing {
      message: tc.draw(text()),
    },
    5 => CoreNativeError::DocumentParse {
      parser: tc.draw(core_parser_kind()),
      message: tc.draw(text()),
    },
    6 => CoreNativeError::Panic {
      message: tc.draw(text()),
    },
    _ => CoreNativeError::Internal {
      message: tc.draw(text()),
    },
  }
}

/// Arbitrary JSON values and raw strings never panic inside `parse_json_input`
/// and every failure produces a structured `NATIVE_INVALID_INPUT` error with a
/// non-empty `path`.
#[hegel::test]
fn parse_json_input_never_panics_on_arbitrary_json(tc: TestCase) {
  let raw = if tc.draw(gs::booleans()) {
    let value = tc.draw(hegel::extras::serde_json::values());
    serde_json::to_string(&value).unwrap_or_default()
  } else {
    tc.draw(gs::text().max_size(128))
  };

  for result in [
    parse_json_input::<DeriveCoreHtmlRequest>("req", &raw).map(|_| ()),
    parse_json_input::<ParseRawDocumentRequest>("req", &raw).map(|_| ()),
    parse_json_input::<NativeCallContext>("ctx", &raw).map(|_| ()),
    parse_json_input::<CoreParsers>("parsers", &raw).map(|_| ()),
  ] {
    if let Err(CoreNativeError::InvalidInput {
      argument,
      path,
      message,
    }) = result
    {
      assert!(!argument.is_empty());
      assert!(!path.is_empty());
      assert!(!message.is_empty());
    } else {
      assert!(result.is_ok());
    }
  }
}

/// Invalid nested fields report exact dotted `input.path` values both in the
/// returned `CoreNativeError::InvalidInput` and on the active tracing span.
#[hegel::test]
fn parse_json_input_reports_dotted_path_on_error_and_span(tc: TestCase) {
  let bad_selector: Value = match tc.draw(gs::integers::<u8>().max_value(3)) {
    0 => json!(tc.draw(gs::integers::<i64>())),
    1 => json!(tc.draw(gs::booleans())),
    2 => json!([]),
    _ => json!({ "nested": true }),
  };

  let payload = json!({
    "url": "https://example.com",
    "onlyMainContent": true,
    "includeTags": [],
    "excludeTags": [],
    "needMetadata": false,
    "needLinks": false,
    "needImages": false,
    "attributes": [
      { "selector": "a", "attribute": "href" },
      { "selector": bad_selector, "attribute": "src" }
    ],
    "removeBase64Images": false
  });
  let serialized = serde_json::to_string(&payload).unwrap_or_default();

  let recorded = Arc::new(Mutex::new(RecordedFields::default()));
  let subscriber = tracing_subscriber::registry().with(InputCaptureLayer {
    recorded: Arc::clone(&recorded),
  });

  let outcome = tracing::subscriber::with_default(subscriber, || {
    let span = tracing::info_span!(
      "derive_core_html",
      input.argument = tracing::field::Empty,
      input.path = tracing::field::Empty,
    );
    span.in_scope(|| parse_json_input::<DeriveCoreHtmlRequest>("req", &serialized))
  });

  assert!(
    matches!(outcome, Err(CoreNativeError::InvalidInput { .. })),
    "expected InvalidInput for invalid selector, got {outcome:?}"
  );
  if let Err(CoreNativeError::InvalidInput { argument, path, .. }) = outcome {
    assert_eq!(argument, "req");
    assert_eq!(path, "attributes[1].selector");
    let captured = recorded
      .lock()
      .unwrap_or_else(PoisonError::into_inner)
      .clone();
    assert_eq!(captured.argument.as_deref(), Some("req"));
    assert_eq!(captured.path.as_deref(), Some("attributes[1].selector"));
  }
}

/// Every `CoreNativeError` variant round-trips losslessly through the
/// `CODE|{json}` transport string representation.
#[hegel::test]
fn core_native_error_transport_string_round_trips(tc: TestCase) {
  let error = tc.draw(core_native_error());
  let failure = error.to_failure();
  let wire = error.to_transport_string();

  let prefix = format!("{}|", failure.code());
  assert!(
    wire.starts_with(&prefix),
    "wire string did not start with expected prefix {prefix}: {wire}"
  );

  let decoded = CoreNativeFailure::from_transport_string(&wire);
  assert_eq!(decoded, Some(failure.clone()), "failed to decode: {wire}");
  if let Some(decoded) = decoded {
    assert_eq!(CoreNativeError::from(decoded), error);
  }
}

#[test]
fn parse_json_input_rejects_trailing_tokens_with_root_path() {
  let recorded = Arc::new(Mutex::new(RecordedFields::default()));
  let subscriber = tracing_subscriber::registry().with(InputCaptureLayer {
    recorded: Arc::clone(&recorded),
  });

  let outcome = tracing::subscriber::with_default(subscriber, || {
    let span = tracing::info_span!(
      "native_call",
      input.argument = tracing::field::Empty,
      input.path = tracing::field::Empty,
    );
    span.in_scope(|| {
      parse_json_input::<NativeCallContext>("ctx", r#"{"zeroDataRetention": false} trailing"#)
    })
  });

  assert!(
    matches!(
      outcome,
      Err(CoreNativeError::InvalidInput {
        ref argument,
        ref path,
        ..
      }) if argument == "ctx" && path == "."
    ),
    "expected InvalidInput with path `.`, got {outcome:?}"
  );

  let captured = recorded
    .lock()
    .unwrap_or_else(PoisonError::into_inner)
    .clone();
  assert_eq!(captured.argument.as_deref(), Some("ctx"));
  assert_eq!(captured.path.as_deref(), Some("."));
}

#[test]
fn boundary_request_validation_enforces_required_zdr_unknown_fields_and_max_pages() {
  // Missing zeroDataRetention fails closed instead of defaulting to false.
  assert!(matches!(
    parse_json_input::<NativeCallContext>("ctx", r#"{}"#),
    Err(CoreNativeError::InvalidInput { .. })
  ));
  assert!(parse_json_input::<NativeCallContext>("ctx", r#"{"zeroDataRetention": true}"#).is_ok());

  // Unknown fields on boundary request structs are rejected.
  assert!(matches!(
    parse_json_input::<NativeCallContext>("ctx", r#"{"zeroDataRetention": false, "extra": 1}"#),
    Err(CoreNativeError::InvalidInput { .. })
  ));
  assert!(matches!(
    parse_json_input::<ParseRawDocumentRequest>(
      "req",
      r#"{"url": "https://example.com", "unknownField": true}"#,
    ),
    Err(CoreNativeError::InvalidInput { .. })
  ));
  assert!(matches!(
    parse_json_input::<DeriveCoreHtmlRequest>(
      "req",
      r#"{"url":"https://example.com","onlyMainContent":true,"needMetadata":false,"needLinks":false,"needImages":false,"removeBase64Images":false,"typo":1}"#,
    ),
    Err(CoreNativeError::InvalidInput { .. })
  ));

  // PDF maxPages enforces the TS schema bounds 1..=10000.
  assert!(matches!(
    parse_json_input::<CoreParsers>("parsers", r#"[{"type": "pdf", "maxPages": 0}]"#),
    Err(CoreNativeError::InvalidInput { .. })
  ));
  assert!(matches!(
    parse_json_input::<CoreParsers>("parsers", r#"[{"type": "pdf", "maxPages": 10001}]"#),
    Err(CoreNativeError::InvalidInput { .. })
  ));
  assert!(
    parse_json_input::<CoreParsers>("parsers", r#"[{"type": "pdf", "maxPages": 1}]"#).is_ok()
  );
  assert!(
    parse_json_input::<CoreParsers>("parsers", r#"[{"type": "pdf", "maxPages": 10000}]"#).is_ok()
  );
}
