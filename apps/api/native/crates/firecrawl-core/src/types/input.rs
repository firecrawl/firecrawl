//! Boundary JSON deserialization with dotted error paths recorded onto the
//! active `tracing` span.

use std::cell::RefCell;

use serde::{Deserialize, Deserializer, de::DeserializeOwned};
use serde_json::Error;
use tracing::Span;

use super::error::CoreNativeError;

struct BufferedError {
  path: String,
  source: Error,
}

impl BufferedError {
  fn into_invalid_input(self, argument: &'static str) -> CoreNativeError {
    let Self { path, source } = self;
    record_input_error(argument, &path);
    let message = if path == "." {
      source.to_string()
    } else {
      format!("{path}: {source}")
    };
    CoreNativeError::InvalidInput {
      argument: argument.to_string(),
      path,
      message,
    }
  }
}

thread_local! {
  static ERROR_SCOPES: RefCell<Vec<Option<BufferedError>>> = const { RefCell::new(Vec::new()) };
}

struct ErrorScope;

impl Drop for ErrorScope {
  fn drop(&mut self) {
    ERROR_SCOPES.with_borrow_mut(|scopes| {
      scopes.pop();
    });
  }
}

fn deserialize_tracked<'de, T, D>(deserializer: D) -> Result<T, BufferedError>
where
  T: Deserialize<'de>,
  D: Deserializer<'de, Error = Error>,
{
  // Serde erases the path inside a buffered map when its visitor returns a custom error.
  ERROR_SCOPES.with_borrow_mut(|scopes| scopes.push(None));
  let _scope = ErrorScope;
  serde_path_to_error::deserialize(deserializer).map_err(|err| {
    let mut path = normalize_error_path(err.path());
    let source = err.into_inner();
    let buffered = ERROR_SCOPES.with_borrow_mut(|scopes| scopes.last_mut().and_then(Option::take));
    if let Some(buffered) = buffered {
      let original = buffered.source.to_string();
      let message = source.to_string();
      let location = format!(" at line {} column {}", source.line(), source.column());
      if message == original || message.strip_suffix(&location) == Some(original.as_str()) {
        if path == "." {
          path = buffered.path;
        } else {
          if !buffered.path.starts_with('[') {
            path.push('.');
          }
          path.push_str(&buffered.path);
        }
      }
    }
    BufferedError { path, source }
  })
}

pub(super) fn deserialize_buffered<T: DeserializeOwned>(
  value: serde_json::Value,
) -> Result<T, Error> {
  deserialize_tracked(value).map_err(|err| {
    let error = serde::de::Error::custom(&err.source);
    if err.path != "." {
      ERROR_SCOPES.with_borrow_mut(|scopes| {
        if let Some(slot) = scopes.last_mut() {
          *slot = Some(err);
        }
      });
    }
    error
  })
}

fn record_input_error(argument: &'static str, path: &str) {
  let span = Span::current();
  span.record("input.argument", argument);
  span.record("input.path", path);
}

fn normalize_error_path(path: &serde_path_to_error::Path) -> String {
  let rendered = path.to_string();
  if rendered.is_empty() {
    ".".to_string()
  } else {
    rendered
  }
}

/// Deserializes a JSON string argument using `serde_path_to_error`, recording
/// `input.argument` and `input.path` on the active span when deserialization
/// fails and rejecting trailing non-whitespace tokens.
pub fn parse_json_input<T: DeserializeOwned>(
  argument: &'static str,
  json: &str,
) -> Result<T, CoreNativeError> {
  let mut deserializer = serde_json::Deserializer::from_str(json);
  match deserialize_tracked(&mut deserializer) {
    Ok(value) => {
      if let Err(err) = deserializer.end() {
        let path = ".";
        record_input_error(argument, path);
        return Err(CoreNativeError::InvalidInput {
          argument: argument.to_string(),
          path: path.to_string(),
          message: err.to_string(),
        });
      }
      Ok(value)
    }
    Err(err) => Err(err.into_invalid_input(argument)),
  }
}

/// Deserializes a `serde_json::Value` argument using `serde_path_to_error`,
/// recording `input.argument` and `input.path` on the active span on failure.
pub fn parse_json_value<T: DeserializeOwned>(
  argument: &'static str,
  value: serde_json::Value,
) -> Result<T, CoreNativeError> {
  deserialize_tracked(value).map_err(|err| err.into_invalid_input(argument))
}
