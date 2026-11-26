//! Result-side domain and operator matching against an `OperatorPlan`.

use url::Url;

use crate::operators::{OperatorPlan, split_site_host_path};
use crate::text::{decode_uri, is_js_whitespace, to_lowercase_cow};

fn matches_site(parsed: &Url, site: &str) -> bool {
  let (host, path) = split_site_host_path(site);
  let hostname = to_lowercase_cow(parsed.host_str().unwrap_or(""));
  let host_matches = hostname.as_ref() == host
    || hostname
      .strip_suffix(host)
      .is_some_and(|prefix| prefix.ends_with('.'));
  if !host_matches {
    return false;
  }
  path.is_empty() || to_lowercase_cow(parsed.path()).starts_with(path)
}

/// True when the URL's host is, or is under, an included domain and no excluded
/// one.
pub fn matches_domains(
  url: Option<&str>,
  include_domains: &[String],
  exclude_domains: &[String],
) -> bool {
  if include_domains.is_empty() && exclude_domains.is_empty() {
    return true;
  }
  let Ok(parsed) = Url::parse(url.unwrap_or("")) else {
    return false;
  };
  !exclude_domains.iter().any(|d| matches_site(&parsed, d))
    && (include_domains.is_empty() || include_domains.iter().any(|d| matches_site(&parsed, d)))
}

fn decoded_url_lower(url: &str) -> String {
  decode_uri(url)
    .map(|decoded| decoded.to_lowercase())
    .unwrap_or_else(|| url.to_lowercase())
}

fn in_url(url: &str, term: &str) -> bool {
  term.split(is_js_whitespace).all(|word| url.contains(word))
}

/// Evaluates an `OperatorPlan` against a search result candidate's URL and title.
pub fn matches_query_operators(
  url: Option<&str>,
  title: Option<&str>,
  plan: &OperatorPlan,
) -> bool {
  let operators = &plan.operators;
  let filters_sites = !operators.sites.is_empty() || !operators.excluded_sites.is_empty();
  if !filters_sites && !plan.relaxed {
    return true;
  }
  let Some(raw_url) = url.filter(|u| !u.is_empty()) else {
    return false;
  };
  let Ok(parsed) = Url::parse(raw_url) else {
    return false;
  };
  if operators
    .excluded_sites
    .iter()
    .any(|site| matches_site(&parsed, site))
  {
    return false;
  }
  if !operators.sites.is_empty()
    && !operators
      .sites
      .iter()
      .any(|site| matches_site(&parsed, site))
  {
    return false;
  }
  if !plan.relaxed {
    return true;
  }

  let check_url = !operators.inurl.is_empty() || !operators.excluded_inurl.is_empty();
  if check_url {
    let decoded = decoded_url_lower(raw_url);
    if !operators.inurl.iter().all(|term| in_url(&decoded, term))
      || operators
        .excluded_inurl
        .iter()
        .any(|term| in_url(&decoded, term))
    {
      return false;
    }
  }

  let check_title = !operators.intitle.is_empty() || !operators.excluded_intitle.is_empty();
  if check_title {
    let title_lower = to_lowercase_cow(title.unwrap_or(""));
    if !operators
      .intitle
      .iter()
      .all(|term| title_lower.contains(term.as_str()))
      || operators
        .excluded_intitle
        .iter()
        .any(|term| title_lower.contains(term.as_str()))
    {
      return false;
    }
  }

  true
}
