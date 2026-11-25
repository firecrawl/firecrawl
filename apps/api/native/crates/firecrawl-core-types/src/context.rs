//! Per-call tracing and retention context passed across the NAPI boundary.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Context passed from Node.js into native entrypoints to propagate W3C trace
/// context, scrape identifiers, and zero-data-retention (ZDR) enforcement.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct NativeCallContext {
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub traceparent: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub tracestate: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub scrape_id: Option<String>,
  #[serde(default)]
  pub zero_data_retention: bool,
}
