use std::borrow::Cow;

use crate::extract::trim_js_whitespace;
use crate::url_utils::with_extracted_domain;

fn ends_with_dot_suffix(domain: &str, suffix: &str) -> bool {
  let Some(prefix) = domain.strip_suffix(suffix) else {
    return false;
  };
  prefix.ends_with('.')
}

/// Check if `domain` matches a configured pattern (exact domain, parent
/// domain, or `*.domain` wildcard).
pub fn domain_matches_pattern(domain: &str, pattern: &str) -> bool {
  if domain == pattern {
    return true;
  }

  // Intentionally matches the registrable domain itself (`domain == target`) to
  // preserve exact parity with the previous `engine-forcing.ts` implementation.
  let target = pattern.strip_prefix("*.").unwrap_or(pattern);
  domain == target || ends_with_dot_suffix(domain, target)
}

fn with_forcing_domain<T>(url: &str, f: impl FnOnce(&str) -> T) -> Option<T> {
  let trimmed = trim_js_whitespace(url);
  if trimmed.is_empty() {
    return None;
  }

  let lowered: Cow<'_, str> = if trimmed.bytes().all(|b| !b.is_ascii_uppercase() && b < 128) {
    Cow::Borrowed(trimmed)
  } else {
    Cow::Owned(trimmed.to_lowercase())
  };

  with_extracted_domain(&lowered, false, f)
}

/// Extract the registrable domain used for engine-forcing rules, using default
/// ICANN-only PSL parsing (`allowPrivateDomains: false`).
pub fn extract_forcing_domain(url: &str) -> Option<String> {
  with_forcing_domain(url, str::to_owned)
}

/// Match `url` against an ordered list of domain patterns and return the index
/// of the first match.
pub fn match_engine_forcing_pattern(url: &str, patterns: &[String]) -> Option<usize> {
  if patterns.is_empty() {
    return None;
  }
  with_forcing_domain(url, |domain| {
    patterns
      .iter()
      .position(|pattern| domain_matches_pattern(domain, &pattern.to_lowercase()))
  })?
}

/// Pre-normalized ordered matcher for forced-engine domain patterns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineForcingMatcher {
  patterns: Vec<String>,
}

impl EngineForcingMatcher {
  pub fn new(patterns: &[String]) -> Self {
    Self {
      patterns: patterns.iter().map(|p| p.to_lowercase()).collect(),
    }
  }

  pub fn is_empty(&self) -> bool {
    self.patterns.is_empty()
  }

  /// Return the index of the first matching pattern for `url`, if any.
  pub fn match_url(&self, url: &str) -> Option<usize> {
    if self.patterns.is_empty() {
      return None;
    }
    with_forcing_domain(url, |domain| {
      self
        .patterns
        .iter()
        .position(|pattern| domain_matches_pattern(domain, pattern))
    })?
  }
}
