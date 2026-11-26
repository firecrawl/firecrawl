//! Pure-Rust RFC 9309 `robots.txt` parser and evaluator.

use std::collections::HashMap;
use url::Url;

use crate::robots_pattern::{
  Rule, extract_path_and_query, find_rule, format_user_agent, normalize_encoding, parse_js_number,
  split_directive, split_lines, strip_comment, trim_robots,
};

/// Default Firecrawl user-agent priority list when no custom agent is set.
pub const DEFAULT_ROBOTS_USER_AGENTS: &[&str] = &["FireCrawlAgent", "FirecrawlAgent"];

const RELATIVE_BASE: &str = "http://robots-relative.samclarke.com/";

#[derive(Debug, Clone, PartialEq, Eq)]
struct RobotsOrigin {
  scheme: String,
  host: String,
  port: u16,
}

#[derive(Debug, Clone, Default)]
struct AgentGroup {
  rules: Vec<Rule>,
  crawl_delay: Option<f64>,
}

/// Parsed `robots.txt` document that can evaluate many URLs without re-parsing.
#[derive(Debug, Clone)]
pub struct Robots {
  origin: Option<RobotsOrigin>,
  groups: HashMap<String, AgentGroup>,
  sitemaps: Vec<String>,
  preferred_host: Option<String>,
}

impl Robots {
  /// Parse `robots.txt` content scoped to the origin of `robots_txt_url`.
  #[must_use]
  pub fn parse(robots_txt_url: &str, contents: &str) -> Self {
    let origin = parse_robots_url(robots_txt_url).map(|u| origin_of(&u));
    Self::parse_with_origin(origin, contents)
  }

  /// Parse `robots.txt` content without binding to an origin (for callers
  /// that already verified host scope).
  #[must_use]
  pub fn parse_rules_only(contents: &str) -> Self {
    Self::parse_with_origin(None, contents)
  }

  fn parse_with_origin(origin: Option<RobotsOrigin>, contents: &str) -> Self {
    let mut groups: HashMap<String, AgentGroup> = HashMap::new();
    let mut sitemaps: Vec<String> = Vec::new();
    let mut preferred_host: Option<String> = None;

    let mut current_user_agents: Vec<String> = Vec::new();
    let mut is_none_user_agent_state = true;

    for (idx, raw_line) in split_lines(contents).enumerate() {
      let line_number = idx.saturating_add(1);
      let without_comment = strip_comment(raw_line);
      let Some((raw_field, raw_value)) = split_directive(without_comment) else {
        continue;
      };

      let field = trim_robots(raw_field);
      if field.is_empty() {
        continue;
      }
      let value = trim_robots(raw_value);
      let field_lower = field.to_lowercase();

      match field_lower.as_str() {
        "user-agent" => {
          if is_none_user_agent_state {
            current_user_agents.clear();
          }
          if !value.is_empty() {
            current_user_agents.push(format_user_agent(value));
          }
        }
        "disallow" => {
          add_rule(&mut groups, &current_user_agents, value, false, line_number);
        }
        "allow" => {
          add_rule(&mut groups, &current_user_agents, value, true, line_number);
        }
        "crawl-delay" => {
          set_crawl_delay(&mut groups, &current_user_agents, value);
        }
        "sitemap" => {
          if !value.is_empty() {
            sitemaps.push(value.to_string());
          }
        }
        "host" if !value.is_empty() => {
          preferred_host = Some(value.to_lowercase());
        }
        _ => {}
      }

      is_none_user_agent_state = field_lower != "user-agent";
    }

    Self {
      origin,
      groups,
      sitemaps,
      preferred_host,
    }
  }

  /// Returns `Some(true)` if allowed, `Some(false)` if disallowed, or `None`
  /// if `url` is invalid or does not match the `robots.txt` origin.
  #[must_use]
  pub fn is_allowed(&self, url: &str, user_agent: Option<&str>) -> Option<bool> {
    let rule = self.get_rule(url, user_agent)?;
    Some(rule.is_none_or(|r| r.allow))
  }

  /// Returns the opposite of `is_allowed`: `true` if disallowed or if the URL
  /// does not match this `robots.txt` origin, `false` if explicitly allowed.
  #[must_use]
  pub fn is_disallowed(&self, url: &str, user_agent: Option<&str>) -> bool {
    self.is_allowed(url, user_agent) != Some(true)
  }

  /// Returns the 1-based line number of the matching directive, or `-1` if no
  /// rule matched or the URL origin did not match.
  #[must_use]
  pub fn get_matching_line_number(&self, url: &str, user_agent: Option<&str>) -> i32 {
    match self.get_rule(url, user_agent) {
      Some(Some(rule)) => i32::try_from(rule.line_number).unwrap_or(i32::MAX),
      _ => -1,
    }
  }

  /// Returns the crawl delay (in seconds) for `user_agent`, falling back to `*`.
  #[must_use]
  pub fn get_crawl_delay(&self, user_agent: Option<&str>) -> Option<f64> {
    self.group_for(user_agent).and_then(|g| g.crawl_delay)
  }

  /// Returns all `Sitemap:` entries declared in the `robots.txt` file.
  #[must_use]
  pub fn get_sitemaps(&self) -> &[String] {
    &self.sitemaps
  }

  /// Returns the last `Host:` directive value, if present.
  #[must_use]
  pub fn get_preferred_host(&self) -> Option<&str> {
    self.preferred_host.as_deref()
  }

  /// Evaluates `url` using Firecrawl's user-agent priority list and trailing
  /// slash check (blocking `/path` when `/path/` is explicitly disallowed).
  #[must_use]
  pub fn is_url_allowed_by_robots(&self, url: &str, user_agents: Option<&[String]>) -> bool {
    match user_agents {
      Some(agents) => agents
        .iter()
        .any(|ua| self.is_allowed_with_trailing_slash(url, ua)),
      None => DEFAULT_ROBOTS_USER_AGENTS
        .iter()
        .any(|ua| self.is_allowed_with_trailing_slash(url, ua)),
    }
  }

  /// Batch-evaluates multiple URLs using `is_url_allowed_by_robots`.
  #[must_use]
  pub fn filter_urls_allowed(&self, urls: &[String], user_agents: Option<&[String]>) -> Vec<bool> {
    urls
      .iter()
      .map(|url| self.is_url_allowed_by_robots(url, user_agents))
      .collect()
  }

  /// Checks a parsed URL's path and query against this ruleset without
  /// checking origin equality (used by `filter_links` and `filter_url` after
  /// internal-host verification).
  #[must_use]
  pub fn is_url_path_allowed(&self, parsed_url: &Url, user_agent: Option<&str>) -> bool {
    let path = extract_path_and_query(parsed_url);
    match user_agent {
      Some(ua) => self.is_path_allowed_for_agent(&path, ua),
      None => DEFAULT_ROBOTS_USER_AGENTS
        .iter()
        .any(|ua| self.is_path_allowed_for_agent(&path, ua)),
    }
  }

  fn is_allowed_with_trailing_slash(&self, url: &str, user_agent: &str) -> bool {
    let mut allowed = self.is_allowed(url, Some(user_agent)).unwrap_or(true);

    // Also check with trailing slash to catch "Disallow: /path/" for "/path".
    if allowed && !url.ends_with('/') {
      let mut with_slash = String::with_capacity(url.len().saturating_add(1));
      with_slash.push_str(url);
      with_slash.push('/');
      if self.is_allowed(&with_slash, Some(user_agent)) == Some(false) {
        allowed = false;
      }
    }

    allowed
  }

  fn is_path_allowed_for_agent(&self, path: &str, user_agent: &str) -> bool {
    let Some(group) = self.group_for(Some(user_agent)) else {
      return true;
    };
    if !find_rule(path, &group.rules).is_none_or(|r| r.allow) {
      return false;
    }
    if !path.ends_with('/') {
      let mut with_slash = String::with_capacity(path.len().saturating_add(1));
      with_slash.push_str(path);
      with_slash.push('/');
      if find_rule(&with_slash, &group.rules).is_some_and(|r| !r.allow) {
        return false;
      }
    }
    true
  }

  fn group_for(&self, user_agent: Option<&str>) -> Option<&AgentGroup> {
    let ua = user_agent.filter(|s| !s.is_empty()).unwrap_or("*");
    let formatted = format_user_agent(ua);
    self.groups.get(&formatted).or_else(|| self.groups.get("*"))
  }

  /// Returns `None` when the URL is invalid or mismatches the robots origin;
  /// `Some(None)` when valid and no rule matches; `Some(Some(rule))` on match.
  fn get_rule(&self, url: &str, user_agent: Option<&str>) -> Option<Option<&Rule>> {
    let robots_origin = self.origin.as_ref()?;
    let parsed_url = parse_robots_url(url)?;
    if origin_of(&parsed_url) != *robots_origin {
      return None;
    }

    let Some(group) = self.group_for(user_agent) else {
      return Some(None);
    };
    let path = extract_path_and_query(&parsed_url);
    Some(find_rule(&path, &group.rules))
  }
}

fn add_rule(
  groups: &mut HashMap<String, AgentGroup>,
  user_agents: &[String],
  pattern: &str,
  allow: bool,
  line_number: usize,
) {
  let normalized = if pattern.is_empty() {
    None
  } else {
    Some(normalize_encoding(pattern))
  };

  for ua in user_agents {
    let group = groups.entry(ua.clone()).or_default();
    if let Some(ref pat) = normalized {
      group.rules.push(Rule {
        pattern: pat.clone(),
        allow,
        line_number,
      });
    }
  }
}

fn set_crawl_delay(
  groups: &mut HashMap<String, AgentGroup>,
  user_agents: &[String],
  delay_str: &str,
) {
  let delay = parse_js_number(delay_str);
  for ua in user_agents {
    let group = groups.entry(ua.clone()).or_default();
    if let Some(d) = delay {
      group.crawl_delay = Some(d);
    }
  }
}

fn parse_robots_url(raw: &str) -> Option<Url> {
  let base = Url::parse(RELATIVE_BASE).ok()?;
  base.join(raw).ok()
}

fn origin_of(url: &Url) -> RobotsOrigin {
  let scheme = url.scheme().to_string();
  let host = url.host_str().unwrap_or("").to_string();
  let port = url
    .port()
    .unwrap_or(if scheme == "https" { 443 } else { 80 });
  RobotsOrigin { scheme, host, port }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn decodes_unreserved_percent_escapes_without_decoding_reserved() {
    let robots = Robots::parse(
      "https://example.com/robots.txt",
      "User-agent: *\nDisallow: /baz\nDisallow: /%61dmin\nDisallow: /a/b\n",
    );
    assert_eq!(
      robots.is_allowed("https://example.com/b%61z", None),
      Some(false)
    );
    assert_eq!(
      robots.is_allowed("https://example.com/admin", None),
      Some(false)
    );
    // Reserved %2F stays distinct from '/'.
    assert_eq!(
      robots.is_allowed("https://example.com/a%2Fb", None),
      Some(true)
    );
  }

  #[test]
  fn preserves_empty_query_delimiter_for_matching() {
    let robots = Robots::parse(
      "https://example.com/robots.txt",
      "User-agent: *\nDisallow: /search?$\n",
    );
    assert_eq!(
      robots.is_allowed("https://example.com/search?", None),
      Some(false)
    );
    assert_eq!(
      robots.is_allowed("https://example.com/search", None),
      Some(true)
    );
  }

  #[test]
  fn path_only_evaluator_enforces_trailing_slash_disallow() {
    let robots = Robots::parse_rules_only("User-agent: *\nDisallow: /blocked/\n");
    let parsed = Url::parse("https://example.com/blocked").ok();
    assert!(parsed.is_some());
    if let Some(url) = parsed {
      assert!(!robots.is_url_path_allowed(&url, None));
    }
  }
}
