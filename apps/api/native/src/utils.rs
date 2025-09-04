use napi::bindgen_prelude::*;

pub fn to_napi_err<E: std::fmt::Display>(error: E) -> Error {
  Error::new(Status::GenericFailure, error.to_string())
}
