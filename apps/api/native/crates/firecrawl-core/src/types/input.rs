//! Boundary JSON deserialization with dotted error paths recorded onto the
//! active `tracing` span.

use serde::de::DeserializeOwned;
use tracing::Span;

use super::error::CoreNativeError;

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
  match serde_path_to_error::deserialize(&mut deserializer) {
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
    Err(err) => {
      let path = normalize_error_path(err.path());
      record_input_error(argument, &path);
      Err(CoreNativeError::InvalidInput {
        argument: argument.to_string(),
        path,
        message: err.to_string(),
      })
    }
  }
}

/// Deserializes a `serde_json::Value` argument using `serde_path_to_error`,
/// recording `input.argument` and `input.path` on the active span on failure.
pub fn parse_json_value<T: DeserializeOwned>(
  argument: &'static str,
  value: serde_json::Value,
) -> Result<T, CoreNativeError> {
  serde_path_to_error::deserialize(value).map_err(|err| {
    let path = normalize_error_path(err.path());
    record_input_error(argument, &path);
    CoreNativeError::InvalidInput {
      argument: argument.to_string(),
      path,
      message: err.to_string(),
    }
  })
}
