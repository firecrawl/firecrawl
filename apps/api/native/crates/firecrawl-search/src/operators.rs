//! Search query operator parsing and planning.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::{Captures, Regex};
use serde::{Deserialize, Serialize};
use url::Host;

use crate::text::{collapse_js_whitespace, is_js_whitespace, js_trim};

// ECMAScript `\s` character class for regex parity with JS.
const JS_WS: &str = r"\t\n\x0B\x0C\r \u{00A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueryOperators {
  pub sites: Vec<String>,
  pub excluded_sites: Vec<String>,
  pub inurl: Vec<String>,
  pub intitle: Vec<String>,
  pub excluded_inurl: Vec<String>,
  pub excluded_intitle: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OperatorPlan {
  pub query: String,
  pub operators: QueryOperators,
  pub relaxed: bool,
}

static OPERATOR_TOKEN_RE: LazyLock<Option<Regex>> = LazyLock::new(|| {
  let pattern = format!(
    r#"("[^"]*")|(^|[{ws}(])(-?)([Ss][Ii][Tt][Ee]|[Ii][Nn][Uu][Rr][Ll]|[Ii][Nn][Tt][Ii][Tt][Ll][Ee]):(?:"([^"]*)"|([^{ws}()]+))(\)*)"#,
    ws = JS_WS,
  );
  Regex::new(&pattern).ok()
});

static QUOTED_PHRASE_RE: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r#""[^"]*""#).ok());

static USES_SYNTAX_OP_RE: LazyLock<Option<Regex>> = LazyLock::new(|| {
  let pattern = format!(r"(?:^|[{ws}(-])[A-Za-z]+:[^{ws}]", ws = JS_WS);
  Regex::new(&pattern).ok()
});

static USES_SYNTAX_OR_RE: LazyLock<Option<Regex>> = LazyLock::new(|| {
  let pattern = format!(r"(?:^|[{ws}(])(?:OR|\|)(?:[{ws})(]|$)", ws = JS_WS);
  Regex::new(&pattern).ok()
});

static SITE_OR_PREFIX_RE: LazyLock<Option<Regex>> = LazyLock::new(|| {
  let pattern = format!(
    r"[Ss][Ii][Tt][Ee]:[^{ws}()]+\)*[{ws}]+(?:[Oo][Rr]|\|)[{ws}]+",
    ws = JS_WS,
  );
  Regex::new(&pattern).ok()
});

fn domain_to_ascii(host: &str) -> Option<String> {
  if host.is_empty() {
    return None;
  }
  Host::parse(host).ok().map(|h| h.to_string())
}

fn strip_ascii_scheme(value: &str) -> &str {
  let bytes = value.as_bytes();
  let mut i: usize = 0;
  while let Some(&b) = bytes.get(i) {
    if b.is_ascii_lowercase() {
      if let Some(next) = i.checked_add(1) {
        i = next;
      } else {
        return value;
      }
    } else {
      break;
    }
  }
  if i > 0
    && let Some(rest) = value.get(i..)
    && let Some(stripped) = rest.strip_prefix("://")
  {
    return stripped;
  }
  value
}

fn normalize_site(value: &str) -> String {
  let site = strip_ascii_scheme(value).trim_end_matches('/');
  let (host, path) = split_site_host_path(site);
  let normalized_host = domain_to_ascii(host);
  let host_part = normalized_host.as_deref().unwrap_or(host);
  let mut out = String::with_capacity(host_part.len().saturating_add(path.len()));
  out.push_str(host_part);
  out.push_str(path);
  out
}

pub(crate) fn split_site_host_path(site: &str) -> (&str, &str) {
  site
    .find('/')
    .and_then(|idx| Some((site.get(..idx)?, site.get(idx..)?)))
    .unwrap_or((site, ""))
}

fn count_or_tokens(unquoted: &str) -> usize {
  let mut count: usize = 0;
  let mut prev: Option<char> = None;

  for (idx, ch) in unquoted.char_indices() {
    let at_boundary = match prev {
      None => true,
      Some(p) => is_js_whitespace(p) || p == '(',
    };

    if at_boundary {
      let rest = unquoted.get(idx..).unwrap_or("");
      let after_token = if ch == '|' {
        rest.get(1..)
      } else if rest.starts_with("OR") {
        rest.get(2..)
      } else {
        None
      };

      if let Some(after) = after_token {
        let valid_end = match after.chars().next() {
          None => true,
          Some(next) => is_js_whitespace(next) || next == ')' || next == '(',
        };
        if valid_end {
          count = count.saturating_add(1);
        }
      }
    }

    prev = Some(ch);
  }

  count
}

fn starts_with_parens_site(s: &str) -> bool {
  let trimmed = s.trim_start_matches('(');
  trimmed
    .get(..5)
    .is_some_and(|prefix| prefix.eq_ignore_ascii_case("site:"))
}

fn count_site_ors(unquoted: &str) -> usize {
  let Some(re) = SITE_OR_PREFIX_RE.as_ref() else {
    return 0;
  };
  let mut count: usize = 0;
  let mut pos: usize = 0;

  while pos <= unquoted.len() {
    let Some(m) = re.find_at(unquoted, pos) else {
      break;
    };
    let tail = unquoted.get(m.end()..).unwrap_or("");
    if starts_with_parens_site(tail) {
      count = count.saturating_add(1);
      pos = m.end();
    } else if let Some(first_ch) = unquoted.get(m.start()..).and_then(|s| s.chars().next()) {
      let Some(next) = m.start().checked_add(first_ch.len_utf8()) else {
        break;
      };
      pos = next;
    } else {
      break;
    }
  }

  count
}

fn has_unsupported_or(query: &str) -> bool {
  let unquoted = match QUOTED_PHRASE_RE.as_ref() {
    Some(re) => re.replace_all(query, " "),
    None => std::borrow::Cow::Borrowed(query),
  };
  count_or_tokens(&unquoted) > count_site_ors(&unquoted)
}

/// True when the query uses search syntax: a quoted phrase, a `name:value`
/// token such as `site:` or `filetype:`, or an `OR` or `|` between terms.
pub fn uses_search_syntax(query: &str) -> bool {
  if query.contains('"') {
    return true;
  }
  USES_SYNTAX_OP_RE
    .as_ref()
    .is_some_and(|re| re.is_match(query))
    || USES_SYNTAX_OR_RE
      .as_ref()
      .is_some_and(|re| re.is_match(query))
}

/// Parses `site:`, `inurl:`, `intitle:` and their negated forms outside quotes.
pub fn parse_query_operators(query: &str) -> QueryOperators {
  let mut operators = QueryOperators::default();
  let Some(re) = OPERATOR_TOKEN_RE.as_ref() else {
    return operators;
  };

  for caps in re.captures_iter(query) {
    if caps.get(1).is_some() {
      continue;
    }
    let raw_val = caps
      .get(5)
      .or_else(|| caps.get(6))
      .map_or("", |m| m.as_str());
    let value = js_trim(raw_val).to_lowercase();
    if value.is_empty() {
      continue;
    }

    let negated = caps.get(3).is_some_and(|m| m.as_str() == "-");
    let Some(op_name) = caps.get(4).map(|m| m.as_str()) else {
      continue;
    };

    if op_name.eq_ignore_ascii_case("site") {
      let site = normalize_site(&value);
      if !site.is_empty() {
        if negated {
          operators.excluded_sites.push(site);
        } else {
          operators.sites.push(site);
        }
      }
    } else if op_name.eq_ignore_ascii_case("inurl") {
      if negated {
        operators.excluded_inurl.push(value);
      } else {
        operators.inurl.push(value);
      }
    } else if op_name.eq_ignore_ascii_case("intitle") {
      if negated {
        operators.excluded_intitle.push(value);
      } else {
        operators.intitle.push(value);
      }
    }
  }

  operators
}

/// Plans provider-side query rewriting and client-side operator enforcement.
pub fn plan_operator_query(query: &str) -> OperatorPlan {
  if has_unsupported_or(query) {
    return OperatorPlan {
      query: query.to_string(),
      operators: QueryOperators::default(),
      relaxed: false,
    };
  }

  let operators = parse_query_operators(query);
  let relaxed = !operators.sites.is_empty()
    && (!operators.inurl.is_empty()
      || !operators.intitle.is_empty()
      || !operators.excluded_inurl.is_empty()
      || !operators.excluded_intitle.is_empty());

  if !relaxed {
    return OperatorPlan {
      query: query.to_string(),
      operators,
      relaxed,
    };
  }

  let rewritten = match OPERATOR_TOKEN_RE.as_ref() {
    Some(re) => {
      let replaced = re.replace_all(query, |caps: &Captures<'_>| {
        let full = caps.get(0).map_or("", |m| m.as_str());
        if caps.get(1).is_some()
          || caps
            .get(4)
            .is_some_and(|m| m.as_str().eq_ignore_ascii_case("site"))
        {
          return full.to_string();
        }
        let lead = caps.get(2).map_or("", |m| m.as_str());
        let negated = caps.get(3).is_some_and(|m| !m.as_str().is_empty());
        let closing = caps.get(7).map_or("", |m| m.as_str());
        if negated {
          format!("{lead}{closing}")
        } else if let Some(quoted) = caps.get(5) {
          format!("{lead}\"{}\"{closing}", quoted.as_str())
        } else {
          let bare = caps.get(6).map_or("", |m| m.as_str());
          format!("{lead}{bare}{closing}")
        }
      });
      collapse_js_whitespace(&replaced)
    }
    None => query.to_string(),
  };

  OperatorPlan {
    query: rewritten,
    operators,
    relaxed,
  }
}

/// Deduplicated hostnames extracted from `site:` values in insertion order.
pub fn site_hostnames(sites: &[String]) -> Vec<String> {
  let mut seen: HashSet<&str> = HashSet::new();
  let mut out = Vec::new();
  for site in sites {
    let host = site.split('/').next().unwrap_or("");
    if !host.is_empty() && seen.insert(host) {
      out.push(host.to_string());
    }
  }
  out
}

#[cfg(test)]
mod regex_tests {
  use super::*;

  #[test]
  fn static_regexes_compile() {
    assert!(OPERATOR_TOKEN_RE.is_some());
    assert!(QUOTED_PHRASE_RE.is_some());
    assert!(USES_SYNTAX_OP_RE.is_some());
    assert!(USES_SYNTAX_OR_RE.is_some());
    assert!(SITE_OR_PREFIX_RE.is_some());
  }
}
