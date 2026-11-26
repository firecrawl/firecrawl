use std::borrow::Cow;

use url::Url;

use crate::extract::trim_js_whitespace;
use crate::url_utils::parse_hostname_ref;

const MAX_QUERY_UTF16_UNITS: usize = 200;

/// Supported search engines recognized by `detect_serp_page`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SerpEngine {
  Google,
  Bing,
  DuckDuckGo,
  Brave,
  Yahoo,
  Baidu,
  Yandex,
  Ecosia,
  Startpage,
}

impl SerpEngine {
  pub const fn as_str(self) -> &'static str {
    match self {
      Self::Google => "Google",
      Self::Bing => "Bing",
      Self::DuckDuckGo => "DuckDuckGo",
      Self::Brave => "Brave",
      Self::Yahoo => "Yahoo",
      Self::Baidu => "Baidu",
      Self::Yandex => "Yandex",
      Self::Ecosia => "Ecosia",
      Self::Startpage => "Startpage",
    }
  }
}

/// Detected search engine results page and normalized query string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SerpPage {
  pub engine: SerpEngine,
  pub query: String,
}

fn truncate_utf16(s: &str, max_units: usize) -> String {
  let mut units: usize = 0;
  let mut end: usize = 0;
  for (idx, c) in s.char_indices() {
    let next_units = units.saturating_add(c.len_utf16());
    if next_units > max_units {
      break;
    }
    units = next_units;
    end = idx.saturating_add(c.len_utf8());
  }
  s.get(..end).unwrap_or("").to_owned()
}

fn query_param(url: &Url, names: &[&str]) -> Option<String> {
  for &name in names {
    if let Some((_, value)) = url.query_pairs().find(|(k, _)| k == name) {
      let trimmed = trim_js_whitespace(value.as_ref());
      if !trimmed.is_empty() {
        return Some(truncate_utf16(trimmed, MAX_QUERY_UTF16_UNITS));
      }
    }
  }
  None
}

fn match_engine(
  url: &Url,
  engine: SerpEngine,
  path_matches: bool,
  param_names: &[&str],
) -> Option<SerpPage> {
  if !path_matches {
    return None;
  }
  let query = query_param(url, param_names)?;
  Some(SerpPage { engine, query })
}

/// Return the search engine and query when `url` is a search results page,
/// otherwise `None`.
pub fn detect_serp_page(url: &str) -> Option<SerpPage> {
  let parsed = Url::parse(url).ok()?;
  if !matches!(parsed.scheme(), "http" | "https") {
    return None;
  }

  let raw_host = parsed.host_str().unwrap_or("");
  let host: Cow<'_, str> = if raw_host.bytes().all(|b| !b.is_ascii_uppercase() && b < 128) {
    Cow::Borrowed(raw_host)
  } else {
    Cow::Owned(raw_host.to_lowercase())
  };

  let parsed_host = parse_hostname_ref(&host, true);
  let domain = parsed_host.domain.unwrap_or("");
  let domain_without_suffix = parsed_host.domain_without_suffix.unwrap_or("");
  let subdomain = parsed_host.subdomain.unwrap_or("");

  let trimmed_path = parsed.path().trim_end_matches('/');
  let path = if trimmed_path.is_empty() {
    "/"
  } else {
    trimmed_path
  };
  let bare_or_www = subdomain.is_empty() || subdomain == "www";

  if domain_without_suffix == "google" && bare_or_www {
    return match_engine(&parsed, SerpEngine::Google, path == "/search", &["q"]);
  }
  if domain == "bing.com" {
    return match_engine(&parsed, SerpEngine::Bing, path == "/search", &["q"]);
  }
  if domain == "duckduckgo.com" {
    return match_engine(
      &parsed,
      SerpEngine::DuckDuckGo,
      matches!(path, "/" | "/html" | "/lite"),
      &["q"],
    );
  }
  if host.as_ref() == "search.brave.com" {
    return match_engine(&parsed, SerpEngine::Brave, path == "/search", &["q"]);
  }
  if domain_without_suffix == "yahoo" && (subdomain == "search" || subdomain.ends_with(".search")) {
    let yahoo_path =
      path == "/search" || path.starts_with("/search/") || path.starts_with("/search;");
    return match_engine(&parsed, SerpEngine::Yahoo, yahoo_path, &["p", "q"]);
  }
  if domain == "baidu.com" && bare_or_www {
    return match_engine(&parsed, SerpEngine::Baidu, path == "/s", &["wd", "word"]);
  }
  if domain_without_suffix == "yandex" && bare_or_www {
    return match_engine(&parsed, SerpEngine::Yandex, path == "/search", &["text"]);
  }
  if domain == "ecosia.org" {
    return match_engine(&parsed, SerpEngine::Ecosia, path == "/search", &["q"]);
  }
  if domain == "startpage.com" {
    return match_engine(
      &parsed,
      SerpEngine::Startpage,
      matches!(path, "/do/search" | "/sp/search"),
      &["q", "query"],
    );
  }

  None
}
