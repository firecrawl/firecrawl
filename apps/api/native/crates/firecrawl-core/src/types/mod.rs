//! Open-source NAPI boundary types, `CODE|{json}` transport errors,
//! `serde_path_to_error` input parsing, `Kinded` union helpers, and
//! deterministic `ts-rs` declaration generation.

pub mod context;
pub mod error;
pub mod html;
pub mod input;
pub mod kinded;
pub mod parsers;
pub mod ts_bindings;

#[cfg(test)]
mod properties;

pub use context::NativeCallContext;
pub use error::{CoreNativeError, CoreNativeFailure};
pub use html::{AttributeRequest, DeriveCoreHtmlRequest, DeriveCoreHtmlResult, ExtractedAttribute};
pub use input::{parse_json_input, parse_json_value};
pub use kinded::{Kinded, KindedSet, kinded};
pub use parsers::{
  CoreParser, CoreParserKind, CoreParsers, CorePdfInspection, CorePdfMode, CorePdfParserOptions,
  CorePdfType, ParseRawDocumentRequest, ParseRawDocumentResult,
};
pub use ts_bindings::render_core_ts_bindings;
