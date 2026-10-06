//! Which transport a FirePDF request takes: sync `/ocr`, or the async `/jobs` cohort.

use sha2::{Digest, Sha256};

use super::{FirePdfConfig, schedule::MIN_ASYNC_CALLER_WINDOW_MS};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AsyncRouteReason {
  Zdr,
  DeadlineTooClose,
  TeamDisabled,
  TeamForced,
  RequestOverride,
  BulkOrigin,
  Percentage,
  PercentageDisabled,
  OutsidePercentage,
}

impl AsyncRouteReason {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Zdr => "zdr",
      Self::DeadlineTooClose => "deadline_too_close",
      Self::TeamDisabled => "team_disabled",
      Self::TeamForced => "team_forced",
      Self::RequestOverride => "request_override",
      Self::BulkOrigin => "bulk_origin",
      Self::Percentage => "percentage",
      Self::PercentageDisabled => "percentage_disabled",
      Self::OutsidePercentage => "outside_percentage",
    }
  }
}

pub struct AsyncRouteInput<'a> {
  pub scrape_id: &'a str,
  pub team_id: &'a str,
  pub zdr: bool,
  pub remaining_ms: Option<i64>,
  /// `__firePdfAsync` on the request's pdf parser.
  pub request_opt_in: bool,
  /// A crawl or batch child: nobody waits on this one document.
  pub bulk_origin: bool,
}

/// Stable position of `key` in `[0, 100)`, so every gate sees the same cohort.
pub fn deterministic_percentage(key: &str) -> f64 {
  let digest = Sha256::digest(key.as_bytes());
  let prefix = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]);
  f64::from(prefix) / 4_294_967_296.0 * 100.0
}

/// Async is a server-controlled cohort within traffic already selected for
/// FirePDF. ZDR and short-deadline requests are always kept out.
pub fn decide_async_route(
  config: &FirePdfConfig,
  input: &AsyncRouteInput,
) -> (bool, AsyncRouteReason) {
  if input.zdr {
    return (false, AsyncRouteReason::Zdr);
  }
  if input
    .remaining_ms
    .is_some_and(|x| x < MIN_ASYNC_CALLER_WINDOW_MS)
  {
    return (false, AsyncRouteReason::DeadlineTooClose);
  }
  if !input.team_id.is_empty() && config.async_disable_team_ids.contains(input.team_id) {
    return (false, AsyncRouteReason::TeamDisabled);
  }
  if !input.team_id.is_empty() && config.async_force_team_ids.contains(input.team_id) {
    return (true, AsyncRouteReason::TeamForced);
  }
  if input.request_opt_in && config.async_allow_request_override {
    return (true, AsyncRouteReason::RequestOverride);
  }
  // Keyed apart from the general cohort so the two percentages stay independent.
  if input.bulk_origin
    && config.async_bulk_origin_percent > 0.0
    && deterministic_percentage(&format!("bulk-origin:{}", input.scrape_id))
      < config.async_bulk_origin_percent
  {
    return (true, AsyncRouteReason::BulkOrigin);
  }
  if config.async_percent <= 0.0 {
    return (false, AsyncRouteReason::PercentageDisabled);
  }
  if deterministic_percentage(input.scrape_id) < config.async_percent {
    return (true, AsyncRouteReason::Percentage);
  }
  (false, AsyncRouteReason::OutsidePercentage)
}

/// Stable label for the page-aware options a request asked for, e.g. "none" or "pages+markers".
pub fn features_label(page_markdown: bool, blocks: bool, page_markers: bool) -> String {
  let parts: Vec<&str> = [
    (page_markdown, "pages"),
    (blocks, "blocks"),
    (page_markers, "markers"),
  ]
  .into_iter()
  .filter_map(|(on, name)| on.then_some(name))
  .collect();
  if parts.is_empty() {
    "none".to_string()
  } else {
    parts.join("+")
  }
}

/// The transport a request's first FirePDF attempt took.
pub struct RouteRecord<'a> {
  pub path: &'static str,
  /// An async route reason, or `by_reference`.
  pub reason: &'static str,
  pub features: &'a str,
  pub remaining_ms: Option<i64>,
}

impl RouteRecord<'_> {
  /// Records the decision on `span`, which declares the `fire_pdf.route.*` fields. Labels only, so it is ZDR-safe.
  pub fn record(&self, span: &tracing::Span) {
    span.record("fire_pdf.route.path", self.path);
    span.record("fire_pdf.route.reason", self.reason);
    span.record("fire_pdf.route.features", self.features);
    span.record("fire_pdf.route.remaining_ms", self.remaining_ms);
  }
}
