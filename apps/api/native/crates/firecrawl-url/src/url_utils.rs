use url::Url;

use crate::extract::{extract_hostname, is_ip, is_valid_hostname, trim_js_whitespace};
use crate::psl_lookup::{
  extract_domain, extract_domain_without_suffix, extract_subdomain, lookup_suffix,
};

/// Result of parsing a hostname or URL against the public suffix list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedHostname {
  pub hostname: Option<String>,
  pub is_ip: Option<bool>,
  pub subdomain: Option<String>,
  pub domain: Option<String>,
  pub public_suffix: Option<String>,
  pub domain_without_suffix: Option<String>,
  pub is_icann: Option<bool>,
  pub is_private: Option<bool>,
  pub is_special_use: Option<bool>,
}

impl ParsedHostname {
  fn empty() -> Self {
    Self {
      hostname: None,
      is_ip: None,
      subdomain: None,
      domain: None,
      public_suffix: None,
      domain_without_suffix: None,
      is_icann: None,
      is_private: None,
      is_special_use: None,
    }
  }
}

/// Zero-allocation borrowed view of a parsed hostname for internal callers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ParsedHostnameRef<'a> {
  pub hostname: &'a str,
  pub is_ip: bool,
  pub subdomain: Option<&'a str>,
  pub domain: Option<&'a str>,
  pub public_suffix: Option<&'a str>,
  pub domain_without_suffix: Option<&'a str>,
  pub is_icann: Option<bool>,
  pub is_private: Option<bool>,
}

impl ParsedHostnameRef<'_> {
  fn to_owned(self) -> ParsedHostname {
    ParsedHostname {
      hostname: Some(self.hostname.to_owned()),
      is_ip: Some(self.is_ip),
      subdomain: self.subdomain.map(str::to_owned),
      domain: self.domain.map(str::to_owned),
      public_suffix: self.public_suffix.map(str::to_owned),
      domain_without_suffix: self.domain_without_suffix.map(str::to_owned),
      is_icann: self.is_icann,
      is_private: self.is_private,
      is_special_use: None,
    }
  }
}

pub(crate) fn parse_hostname_ref<'a>(
  hostname: &'a str,
  allow_private_domains: bool,
) -> ParsedHostnameRef<'a> {
  if is_ip(hostname) {
    return ParsedHostnameRef {
      hostname,
      is_ip: true,
      subdomain: None,
      domain: None,
      public_suffix: None,
      domain_without_suffix: None,
      is_icann: None,
      is_private: None,
    };
  }

  let suffix_match = lookup_suffix(hostname, allow_private_domains);
  let domain = extract_domain(suffix_match.public_suffix, hostname);
  let subdomain = domain.map(|d| extract_subdomain(hostname, d));
  let domain_without_suffix =
    domain.map(|d| extract_domain_without_suffix(d, suffix_match.public_suffix));

  ParsedHostnameRef {
    hostname,
    is_ip: false,
    subdomain,
    domain,
    public_suffix: Some(suffix_match.public_suffix),
    domain_without_suffix,
    is_icann: Some(suffix_match.is_icann),
    is_private: Some(suffix_match.is_private),
  }
}

/// Extract only the registrable domain from a URL or bare host without
/// allocating intermediate fields, passing the borrowed slice to `f`.
pub(crate) fn with_extracted_domain<T>(
  input: &str,
  allow_private_domains: bool,
  f: impl FnOnce(&str) -> T,
) -> Option<T> {
  let url_is_valid = is_valid_hostname(input);
  let hostname = extract_hostname(input, url_is_valid)?;
  if is_ip(&hostname) {
    return None;
  }
  if !(url_is_valid && hostname.as_ref() == input) && !is_valid_hostname(&hostname) {
    return None;
  }
  let suffix_match = lookup_suffix(&hostname, allow_private_domains);
  let domain = extract_domain(suffix_match.public_suffix, &hostname)?;
  Some(f(domain))
}

/// Parse a bare hostname against the public suffix list with private domains
/// enabled (`allowPrivateDomains: true`, `extractHostname: false`).
pub fn parse_hostname(hostname: &str) -> ParsedHostname {
  parse_hostname_ref(hostname, true).to_owned()
}

/// Parse a URL or bare hostname, extracting and validating the hostname first
/// (`extractHostname: true`, `validateHostname: true`, `detectIp: true`).
pub fn parse_url(input: &str, allow_private_domains: bool) -> ParsedHostname {
  let url_is_valid = is_valid_hostname(input);
  let Some(hostname) = extract_hostname(input, url_is_valid) else {
    return ParsedHostname::empty();
  };

  if is_ip(&hostname) {
    let mut out = ParsedHostname::empty();
    out.hostname = Some(hostname.into_owned());
    out.is_ip = Some(true);
    return out;
  }

  if !(url_is_valid && hostname.as_ref() == input) && !is_valid_hostname(&hostname) {
    let mut out = ParsedHostname::empty();
    out.is_ip = Some(false);
    return out;
  }

  parse_hostname_ref(&hostname, allow_private_domains).to_owned()
}

#[inline]
fn is_tld_label_char(c: char) -> bool {
  matches!(
    c,
    'a'..='z'
      | 'A'..='Z'
      | '0'..='9'
      | '-'
      | '\u{0400}'..='\u{052F}'
      | '\u{1C80}'..='\u{1C88}'
      | '\u{2DE0}'..='\u{2DFF}'
      | '\u{A640}'..='\u{A69F}'
  )
}

/// Matches the historic TLD-shaped check:
/// `/(\.[a-zA-Z0-9-Ѐ-ӿԀ-ԯⷠ-ⷿꙀ-ꚟ]{2,}|\.xn--[a-zA-Z0-9-]{1,})(:\d+)?([\/?#]|$)/i`.
fn looks_like_tld(url: &str) -> bool {
  for (dot_idx, _) in url.match_indices('.') {
    let Some(rest) = url.get(dot_idx.saturating_add(1)..) else {
      continue;
    };

    let mut label_chars: usize = 0;
    let mut label_end: usize = 0;
    for (byte_idx, c) in rest.char_indices() {
      if is_tld_label_char(c) {
        label_chars = label_chars.saturating_add(1);
        label_end = byte_idx.saturating_add(c.len_utf8());
      } else {
        break;
      }
    }

    if label_chars < 2 {
      continue;
    }

    let Some(mut tail) = rest.get(label_end..) else {
      continue;
    };

    if let Some(after_colon) = tail.strip_prefix(':') {
      let digit_bytes = after_colon
        .bytes()
        .take_while(|b| b.is_ascii_digit())
        .count();
      if digit_bytes == 0 {
        continue;
      }
      tail = after_colon.get(digit_bytes..).unwrap_or("");
    }

    if tail.is_empty() || matches!(tail.as_bytes().first(), Some(b'/' | b'?' | b'#')) {
      return true;
    }
  }

  false
}

/// Whether a URL's host is plausibly reachable (IP literal or TLD-shaped host).
pub fn has_reachable_host(url: &str) -> bool {
  let url_is_valid = is_valid_hostname(url);
  if let Some(hostname) = extract_hostname(url, url_is_valid)
    && is_ip(&hostname)
  {
    return true;
  }

  looks_like_tld(url)
}

/// Extract the registrable base domain from a full URL, or `None` if invalid.
pub fn extract_base_domain(url: &str) -> Option<String> {
  let parsed_url = Url::parse(url).ok()?;
  let hostname = parsed_url.host_str().unwrap_or("");
  parse_hostname_ref(hostname, true)
    .domain
    .filter(|d| !d.is_empty())
    .map(str::to_owned)
}

/// Determine whether a URL is a root base domain without subdomains or paths.
pub fn is_base_domain(url: &str) -> bool {
  let Ok(parsed_url) = Url::parse(url) else {
    return false;
  };
  let hostname = parsed_url.host_str().unwrap_or("");
  let parsed = parse_hostname_ref(hostname, true);
  let Some(domain) = parsed.domain.filter(|d| !d.is_empty()) else {
    return false;
  };

  let clean_hostname = hostname.strip_prefix("www.").unwrap_or(hostname);
  if clean_hostname != domain {
    return false;
  }

  let pathname = parsed_url.path();
  if !pathname.is_empty() && pathname != "/" && !trim_js_whitespace(pathname).is_empty() {
    return false;
  }

  true
}
