// Pre-existing crawler logic exempt from strict workspace clippy denies.
#![allow(
  clippy::arithmetic_side_effects,
  clippy::collapsible_if,
  clippy::indexing_slicing,
  clippy::unwrap_used
)]

use crate::robots::Robots;
pub use crate::sitemap::{
  ParsedSitemap, SitemapEntry, SitemapIndex, SitemapInstruction, SitemapProcessingResult,
  SitemapUrl, SitemapUrlset, parse_sitemap_xml, process_sitemap,
};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::{
  collections::{HashMap, HashSet},
  sync::LazyLock,
};
use url::Url;

static FILE_EXTENSIONS: &[&str] = &[
  ".png", ".jpg", ".jpeg", ".gif", ".css", ".js", ".ico", ".svg", ".tiff", ".zip", ".exe", ".dmg",
  ".mp4", ".mp3", ".wav", ".pptx", ".xlsx", ".avi", ".flv", ".woff", ".ttf", ".woff2", ".webp",
  ".inc",
];

static FILE_EXT_SET: LazyLock<HashSet<&'static str>> =
  LazyLock::new(|| FILE_EXTENSIONS.iter().copied().collect());

#[derive(Debug, Clone, Deserialize)]
pub struct FilterLinksCall {
  pub links: Vec<String>,
  pub limit: Option<i64>,
  pub max_depth: u32,
  pub base_url: String,
  pub initial_url: String,
  pub regex_on_full_url: bool,
  pub excludes: Vec<String>,
  pub includes: Vec<String>,
  pub allow_backward_crawling: bool,
  pub ignore_robots_txt: bool,
  pub robots_txt: String,
  pub robots_user_agent: Option<String>,
  pub allow_external_content_links: bool,
  pub allow_subdomains: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct FilterLinksResult {
  pub links: Vec<String>,
  pub denial_reasons: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RegexValidationError {
  pub pattern: String,
  pub error: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FilterUrlCall {
  pub href: String,
  pub url: String,
  pub base_url: String,
  pub excludes: Vec<String>,
  pub ignore_robots_txt: bool,
  pub robots_txt: String,
  pub robots_user_agent: Option<String>,
  pub allow_external_content_links: bool,
  pub allow_subdomains: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct FilterUrlResult {
  pub allowed: bool,
  pub url: Option<String>,
  pub denial_reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FilterUrlsCall {
  pub hrefs: Vec<String>,
  pub url: String,
  pub base_url: String,
  pub excludes: Vec<String>,
  pub ignore_robots_txt: bool,
  pub robots_txt: String,
  pub robots_user_agent: Option<String>,
  pub allow_external_content_links: bool,
  pub allow_subdomains: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CrawlScope {
  pub prefix: String,
  pub exact: Option<String>,
}

const URL_PARSE_ERROR: &str = "URL_PARSE_ERROR";
const DEPTH_LIMIT: &str = "DEPTH_LIMIT";
const EXCLUDE_PATTERN: &str = "EXCLUDE_PATTERN";
const INCLUDE_PATTERN: &str = "INCLUDE_PATTERN";
const BACKWARD_CRAWLING: &str = "BACKWARD_CRAWLING";
const ROBOTS_TXT: &str = "ROBOTS_TXT";
const FILE_TYPE: &str = "FILE_TYPE";
const SOCIAL_MEDIA: &str = "SOCIAL_MEDIA";
const EXTERNAL_LINK: &str = "EXTERNAL_LINK";
const SECTION_LINK: &str = "SECTION_LINK";
const NON_WEB_PROTOCOL: &str = "NON_WEB_PROTOCOL";

#[inline]
pub(crate) fn is_file(path: &str) -> bool {
  if let Some(dot_pos) = path.rfind('.') {
    let extension = &path[dot_pos..];
    FILE_EXT_SET.contains(extension)
  } else {
    false
  }
}

static DOCUMENT_SEGMENT: LazyLock<Regex> =
  LazyLock::new(|| Regex::new(r"\.[A-Za-z0-9]{2,}$").unwrap());

/// Resolves the path a crawl is scoped to when backward crawling is disabled.
pub fn get_crawl_scope(initial_url: &str) -> CrawlScope {
  let Ok(parsed) = Url::parse(initial_url) else {
    return CrawlScope {
      prefix: "/".to_string(),
      exact: None,
    };
  };
  crawl_scope(&parsed)
}

fn crawl_scope(initial_url: &Url) -> CrawlScope {
  let path = initial_url.path();
  let normalized = if path.starts_with('/') {
    path.to_string()
  } else {
    format!("/{path}")
  };

  if normalized.ends_with('/') {
    return CrawlScope {
      prefix: normalized,
      exact: None,
    };
  }

  let last_slash = normalized.rfind('/').map_or(0, |i| i + 1);
  if DOCUMENT_SEGMENT.is_match(&normalized[last_slash..]) {
    return CrawlScope {
      prefix: normalized[..last_slash].to_string(),
      exact: None,
    };
  }

  CrawlScope {
    prefix: format!("{normalized}/"),
    exact: Some(normalized),
  }
}

#[inline]
fn is_within_crawl_scope(path: &str, scope: &CrawlScope) -> bool {
  scope.exact.as_deref() == Some(path) || path.starts_with(&scope.prefix)
}

#[inline]
fn get_url_depth(path: &str) -> u32 {
  path
    .split('/')
    .filter(|segment| !segment.is_empty() && *segment != "index.php" && *segment != "index.html")
    .count() as u32
}

#[inline]
fn is_internal_link(url: &Url, base_url: &Url) -> bool {
  let base_domain = base_url
    .host_str()
    .unwrap_or("")
    .trim_start_matches("www.")
    .trim();
  let link_domain = url
    .host_str()
    .unwrap_or("")
    .trim_start_matches("www.")
    .trim();

  link_domain == base_domain
}

#[inline]
fn no_sections(url_str: &str) -> bool {
  if !url_str.contains('#') {
    return true;
  }

  // Check if the hash fragment looks like a route (contains forward slashes and has substantial content)
  if let Some(hash_part) = url_str.split('#').nth(1) {
    hash_part.len() > 1 && hash_part.contains('/')
  } else {
    false
  }
}

#[inline]
fn is_non_web_protocol(url_str: &str) -> bool {
  const NON_WEB_PROTOCOLS: &[&str] = &[
    "mailto:", "tel:", "telnet:", "ftp:", "ftps:", "ssh:", "file:",
  ];

  NON_WEB_PROTOCOLS
    .iter()
    .any(|protocol| url_str.starts_with(protocol))
}

#[inline]
fn is_social_media_or_email(url_str: &str) -> bool {
  const SOCIAL_MEDIA_OR_EMAIL: &[&str] = &[
    "facebook.com",
    "twitter.com",
    "linkedin.com",
    "instagram.com",
    "pinterest.com",
    "github.com",
    "calendly.com",
    "discord.gg",
    "discord.com",
  ];

  SOCIAL_MEDIA_OR_EMAIL
    .iter()
    .any(|domain| url_str.contains(domain))
}

#[inline]
fn is_subdomain(url: &Url, base_url: &Url) -> bool {
  match (url.host_str(), base_url.host_str()) {
    (Some(link_host), Some(base_host)) => {
      match (psl::domain_str(link_host), psl::domain_str(base_host)) {
        (Some(link_domain), Some(base_domain)) => link_domain == base_domain,
        _ => false,
      }
    }
    _ => false,
  }
}

#[inline]
fn is_external_main_page(url_str: &str) -> bool {
  if let Ok(url) = Url::parse(url_str) {
    let path_segments: Vec<&str> = url
      .path_segments()
      .map(|segments| segments.filter(|s| !s.is_empty()).collect())
      .unwrap_or_default();
    path_segments.is_empty()
  } else {
    false
  }
}

fn build_robot(ignore_robots_txt: bool, robots_txt: &str) -> Option<Robots> {
  if ignore_robots_txt || robots_txt.is_empty() {
    return None;
  }
  Some(Robots::parse_rules_only(robots_txt))
}

fn _filter_links(data: FilterLinksCall) -> std::result::Result<FilterLinksResult, String> {
  let limit = data.limit.map_or(usize::MAX, |x| x.max(0) as usize);
  if limit == 0 {
    return Ok(FilterLinksResult {
      links: Vec::new(),
      denial_reasons: HashMap::new(),
    });
  }

  let base_url = Url::parse(&data.base_url).map_err(|e| format!("Base URL parse error: {e}"))?;
  let initial_url =
    Url::parse(&data.initial_url).map_err(|e| format!("Initial URL parse error: {e}"))?;
  let scope = crawl_scope(&initial_url);

  let excludes_regex: Vec<PathRegex> = data
    .excludes
    .iter()
    .filter_map(|e| compile_path_regex(e).ok())
    .collect();
  let includes_regex: Vec<PathRegex> = data
    .includes
    .iter()
    .filter_map(|i| compile_path_regex(i).ok())
    .collect();

  let robot = build_robot(data.ignore_robots_txt, &data.robots_txt);

  let mut result_links = Vec::new();
  let mut denial_reasons = HashMap::new();

  for link in data.links {
    if result_links.len() >= limit {
      break;
    }

    let url = match base_url.join(&link) {
      Ok(url) => url,
      Err(_) => {
        denial_reasons.insert(link, URL_PARSE_ERROR.to_string());
        continue;
      }
    };

    let path = url.path();
    let url_str = url.as_str();

    if is_non_web_protocol(url_str) {
      denial_reasons.insert(link, NON_WEB_PROTOCOL.to_string());
      continue;
    }

    if get_url_depth(path) > data.max_depth {
      denial_reasons.insert(link, DEPTH_LIMIT.to_string());
      continue;
    }

    if is_file(path) {
      denial_reasons.insert(link, FILE_TYPE.to_string());
      continue;
    }

    if is_internal_link(&url, &base_url) {
      // INTERNAL LINKS
      if !no_sections(url_str) {
        denial_reasons.insert(link, SECTION_LINK.to_string());
        continue;
      }

      if !data.allow_backward_crawling && !is_within_crawl_scope(path, &scope) {
        denial_reasons.insert(link, BACKWARD_CRAWLING.to_string());
        continue;
      }

      let match_target = if data.regex_on_full_url {
        url_str
      } else {
        path
      };

      if !excludes_regex.is_empty()
        && excludes_regex
          .iter()
          .any(|r| r.is_match(match_target.as_bytes()))
      {
        denial_reasons.insert(link, EXCLUDE_PATTERN.to_string());
        continue;
      }

      if !includes_regex.is_empty()
        && !includes_regex
          .iter()
          .any(|r| r.is_match(match_target.as_bytes()))
      {
        denial_reasons.insert(link, INCLUDE_PATTERN.to_string());
        continue;
      }

      if let Some(ref robot) = robot {
        if !robot.is_url_path_allowed(&url, data.robots_user_agent.as_deref()) {
          denial_reasons.insert(link, ROBOTS_TXT.to_string());
          continue;
        }
      }

      result_links.push(link);
    } else {
      // EXTERNAL LINKS
      if is_social_media_or_email(url_str) {
        denial_reasons.insert(link, SOCIAL_MEDIA.to_string());
        continue;
      }

      if !excludes_regex.is_empty()
        && excludes_regex
          .iter()
          .any(|r| r.is_match(url_str.as_bytes()))
      {
        denial_reasons.insert(link, EXCLUDE_PATTERN.to_string());
        continue;
      }

      if is_internal_link(&initial_url, &base_url)
        && data.allow_external_content_links
        && !is_external_main_page(url_str)
      {
        result_links.push(link);
        continue;
      }

      if data.allow_subdomains
        && !is_social_media_or_email(url_str)
        && is_subdomain(&url, &base_url)
      {
        // When allowing subdomains, still honor include patterns
        let match_target = if data.regex_on_full_url {
          url_str
        } else {
          path
        };
        if !includes_regex.is_empty()
          && !includes_regex
            .iter()
            .any(|r| r.is_match(match_target.as_bytes()))
        {
          denial_reasons.insert(link, INCLUDE_PATTERN.to_string());
          continue;
        }
        result_links.push(link);
        continue;
      }

      denial_reasons.insert(link, EXTERNAL_LINK.to_string());
    }
  }

  Ok(FilterLinksResult {
    links: result_links,
    denial_reasons,
  })
}

/// Filter links based on crawling rules and constraints.
pub fn filter_links(data: FilterLinksCall) -> Result<FilterLinksResult, String> {
  _filter_links(data)
}

/// Compiled form of a client-supplied includePaths/excludePaths pattern.
///
/// Path patterns are compiled with Unicode mode disabled, over bytes. Every
/// haystack they are matched against is a serialized `url::Url` path or href,
/// which is always percent-encoded ASCII, so ASCII and Unicode mode produce the
/// same matches. Unicode mode is what makes compilation expensive: a Unicode
/// `\w` is hundreds of codepoint ranges, so `\w{50}` alone compiles to more than
/// two megabytes of NFA, and `.{2000}` or `[\w-]{1,100}` several times over hit
/// the crate's 10 MiB default. In ASCII mode the same patterns compile in well
/// under a millisecond, which is what lets the size limit below be tight.
type PathRegex = regex::bytes::Regex;

/// Approximate upper bound, in bytes, on the compiled NFA of a single path
/// pattern. Patterns are untrusted, and the `regex` crate's compile time and
/// heap usage scale with the *compiled* size rather than the pattern's length:
/// `a{5}{5}{5}{5}{5}{5}` is 19 characters but expands to `a{15625}`. The crate's
/// default of 10 MiB lets a short pattern cost tens of milliseconds of CPU per
/// compile; this limit keeps it well under one millisecond while still admitting
/// path filters far larger than any realistic one.
/// https://docs.rs/regex/latest/regex/#untrusted-patterns
const PATH_REGEX_SIZE_LIMIT: usize = 256 * 1024;

/// Cache capacity of the lazy DFA used when matching a path pattern. Bounded so
/// a large pattern cannot claim the crate's 2 MiB default per compiled regex.
const PATH_REGEX_DFA_SIZE_LIMIT: usize = 256 * 1024;

/// Maximum nesting depth of a path pattern's syntax tree (crate default: 250).
const PATH_REGEX_NEST_LIMIT: u32 = 50;

/// Compile an includePaths/excludePaths pattern with resource limits suitable
/// for untrusted input. Every place that compiles a client-supplied path pattern
/// must go through this so validation and filtering agree on what is accepted.
fn compile_path_regex(pattern: &str) -> std::result::Result<PathRegex, regex::Error> {
  regex::bytes::RegexBuilder::new(pattern)
    .unicode(false)
    .size_limit(PATH_REGEX_SIZE_LIMIT)
    .dfa_size_limit(PATH_REGEX_DFA_SIZE_LIMIT)
    .nest_limit(PATH_REGEX_NEST_LIMIT)
    .build()
}

/// Validate regex patterns against the engine's regex flavor (the Rust `regex`
/// crate), which is what link filtering compiles them with. Returns an entry for
/// each pattern that fails to compile so callers can reject unsupported syntax
/// (e.g. look-around, backreferences) instead of silently ignoring it.
pub fn validate_regexes(patterns: Vec<String>) -> Vec<RegexValidationError> {
  patterns
    .into_iter()
    .filter_map(|pattern| match compile_path_regex(&pattern) {
      Ok(_) => None,
      Err(e) => Some(RegexValidationError {
        pattern,
        error: e.to_string(),
      }),
    })
    .collect()
}

struct PreparedUrlFilter<'a> {
  context_url: Option<Url>,
  base_url: Url,
  excludes_regex: Vec<PathRegex>,
  robot: Option<Robots>,
  robots_user_agent: Option<&'a str>,
  allow_external_content_links: bool,
  allow_subdomains: bool,
}

fn filter_single_url_with_prepared(href: &str, filter: &PreparedUrlFilter<'_>) -> FilterUrlResult {
  let mut full_url = href.to_string();

  // Handle relative URLs
  if !href.starts_with("http") {
    match filter
      .context_url
      .as_ref()
      .and_then(|base| base.join(href).ok())
    {
      Some(resolved) => full_url = resolved.to_string(),
      None => {
        return FilterUrlResult {
          allowed: false,
          url: None,
          denial_reason: Some(URL_PARSE_ERROR.to_string()),
        };
      }
    }
  }

  let url = match Url::parse(&full_url) {
    Ok(url) => url,
    Err(_) => {
      return FilterUrlResult {
        allowed: false,
        url: None,
        denial_reason: Some(URL_PARSE_ERROR.to_string()),
      };
    }
  };

  let path = url.path();
  let url_str = url.as_str();

  if is_non_web_protocol(url_str) {
    return FilterUrlResult {
      allowed: false,
      url: None,
      denial_reason: Some(NON_WEB_PROTOCOL.to_string()),
    };
  }

  if is_internal_link(&url, &filter.base_url) {
    // INTERNAL LINKS
    if !no_sections(url_str) {
      return FilterUrlResult {
        allowed: false,
        url: None,
        denial_reason: Some(SECTION_LINK.to_string()),
      };
    }

    if !filter.excludes_regex.is_empty()
      && filter
        .excludes_regex
        .iter()
        .any(|r| r.is_match(path.as_bytes()))
    {
      return FilterUrlResult {
        allowed: false,
        url: None,
        denial_reason: Some(EXCLUDE_PATTERN.to_string()),
      };
    }

    if let Some(ref robot) = filter.robot {
      if !robot.is_url_path_allowed(&url, filter.robots_user_agent) {
        return FilterUrlResult {
          allowed: false,
          url: None,
          denial_reason: Some(ROBOTS_TXT.to_string()),
        };
      }
    }

    FilterUrlResult {
      allowed: true,
      url: Some(full_url),
      denial_reason: None,
    }
  } else {
    // EXTERNAL LINKS
    if is_social_media_or_email(url_str) {
      return FilterUrlResult {
        allowed: false,
        url: None,
        denial_reason: Some(SOCIAL_MEDIA.to_string()),
      };
    }

    if !filter.excludes_regex.is_empty()
      && filter
        .excludes_regex
        .iter()
        .any(|r| r.is_match(url_str.as_bytes()))
    {
      return FilterUrlResult {
        allowed: false,
        url: None,
        denial_reason: Some(EXCLUDE_PATTERN.to_string()),
      };
    }

    let Some(ref context_url) = filter.context_url else {
      return FilterUrlResult {
        allowed: false,
        url: None,
        denial_reason: Some(URL_PARSE_ERROR.to_string()),
      };
    };

    // Allow an external destination when external content links are enabled and
    // it is not an external site's homepage. Two cases qualify: the link was
    // found on an in-scope page, or an already-admitted external link redirected
    // within its own registrable domain (its canonical URL or a subdomain of
    // it), matched via the same PSL check used for allowSubdomains.
    if filter.allow_external_content_links
      && !is_external_main_page(url_str)
      && (is_internal_link(context_url, &filter.base_url)
        || is_subdomain(&url, context_url)
        || is_internal_link(&url, context_url))
    {
      return FilterUrlResult {
        allowed: true,
        url: Some(full_url),
        denial_reason: None,
      };
    }

    if filter.allow_subdomains
      && !is_social_media_or_email(url_str)
      && is_subdomain(&url, &filter.base_url)
    {
      return FilterUrlResult {
        allowed: true,
        url: Some(full_url),
        denial_reason: None,
      };
    }

    FilterUrlResult {
      allowed: false,
      url: None,
      denial_reason: Some(EXTERNAL_LINK.to_string()),
    }
  }
}

fn _filter_url(data: FilterUrlCall) -> std::result::Result<FilterUrlResult, String> {
  let base_url = match Url::parse(&data.base_url) {
    Ok(url) => url,
    Err(_) => {
      return Ok(FilterUrlResult {
        allowed: false,
        url: None,
        denial_reason: Some(URL_PARSE_ERROR.to_string()),
      });
    }
  };

  let prepared = PreparedUrlFilter {
    context_url: Url::parse(&data.url).ok(),
    base_url,
    excludes_regex: data
      .excludes
      .iter()
      .filter_map(|e| compile_path_regex(e).ok())
      .collect(),
    robot: build_robot(data.ignore_robots_txt, &data.robots_txt),
    robots_user_agent: data.robots_user_agent.as_deref(),
    allow_external_content_links: data.allow_external_content_links,
    allow_subdomains: data.allow_subdomains,
  };

  Ok(filter_single_url_with_prepared(&data.href, &prepared))
}

/// Filter a single URL based on crawling rules and constraints.
pub fn filter_url(data: FilterUrlCall) -> Result<FilterUrlResult, String> {
  _filter_url(data)
}

/// Batch-filter candidate hrefs extracted from a single page, compiling exclude
/// patterns and parsing `robots.txt` once for the entire batch.
pub fn filter_urls(data: FilterUrlsCall) -> Result<Vec<String>, String> {
  let Ok(base_url) = Url::parse(&data.base_url) else {
    return Ok(Vec::new());
  };

  let prepared = PreparedUrlFilter {
    context_url: Url::parse(&data.url).ok(),
    base_url,
    excludes_regex: data
      .excludes
      .iter()
      .filter_map(|e| compile_path_regex(e).ok())
      .collect(),
    robot: build_robot(data.ignore_robots_txt, &data.robots_txt),
    robots_user_agent: data.robots_user_agent.as_deref(),
    allow_external_content_links: data.allow_external_content_links,
    allow_subdomains: data.allow_subdomains,
  };

  let mut allowed_urls = Vec::with_capacity(data.hrefs.len());
  for href in &data.hrefs {
    let result = filter_single_url_with_prepared(href, &prepared);
    if result.allowed {
      if let Some(url) = result.url {
        allowed_urls.push(url);
      }
    }
  }

  Ok(allowed_urls)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn scope_of(url: &str) -> CrawlScope {
    crawl_scope(&Url::parse(url).unwrap())
  }

  #[test]
  fn test_crawl_scope_document_seed_scopes_to_directory() {
    let scope = scope_of("https://example.com/docs/guide.md");
    assert_eq!(scope.prefix, "/docs/");
    assert_eq!(scope.exact, None);

    assert!(is_within_crawl_scope("/docs/other.md", &scope));
    assert!(is_within_crawl_scope("/docs/nested/deep.md", &scope));
    assert!(!is_within_crawl_scope("/blog/post.md", &scope));
    assert!(!is_within_crawl_scope("/", &scope));
  }

  #[test]
  fn test_crawl_scope_directory_seed() {
    let scope = scope_of("https://example.com/docs/");
    assert_eq!(scope.prefix, "/docs/");
    assert_eq!(scope.exact, None);

    assert!(is_within_crawl_scope("/docs/guide.md", &scope));
    assert!(!is_within_crawl_scope("/docs", &scope));
    assert!(!is_within_crawl_scope("/docsearch/x", &scope));
  }

  #[test]
  fn test_crawl_scope_extensionless_seed_allows_seed_and_children() {
    let scope = scope_of("https://example.com/docs");
    assert_eq!(scope.prefix, "/docs/");
    assert_eq!(scope.exact.as_deref(), Some("/docs"));

    assert!(is_within_crawl_scope("/docs", &scope));
    assert!(is_within_crawl_scope("/docs/guide", &scope));
    // Sibling paths sharing the seed's prefix must not sneak in.
    assert!(!is_within_crawl_scope("/docsearch", &scope));
  }

  #[test]
  fn test_crawl_scope_root_seed() {
    let scope = scope_of("https://example.com");
    assert_eq!(scope.prefix, "/");
    assert_eq!(scope.exact, None);

    assert!(is_within_crawl_scope("/anything/at/all", &scope));
  }

  #[test]
  fn test_parse_sitemap_xml_urlset() {
    let xml_content = r#"<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/page1</loc>
  </url>
  <url>
    <loc>https://example.com/page2</loc>
  </url>
</urlset>"#;

    let result = parse_sitemap_xml(xml_content).unwrap();
    assert!(result.urlset.is_some());
    let urlset = result.urlset.unwrap();
    assert_eq!(urlset.url.len(), 2);
    assert_eq!(urlset.url[0].loc[0], "https://example.com/page1");
    assert_eq!(urlset.url[1].loc[0], "https://example.com/page2");
  }

  #[test]
  fn test_parse_sitemap_xml_sitemapindex() {
    let xml_content = r#"<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://example.com/sitemap1.xml</loc>
  </sitemap>
  <sitemap>
    <loc>https://example.com/sitemap2.xml</loc>
  </sitemap>
</sitemapindex>"#;

    let result = parse_sitemap_xml(xml_content).unwrap();
    assert!(result.sitemapindex.is_some());
    let sitemapindex = result.sitemapindex.unwrap();
    assert_eq!(sitemapindex.sitemap.len(), 2);
    assert_eq!(
      sitemapindex.sitemap[0].loc[0],
      "https://example.com/sitemap1.xml"
    );
    assert_eq!(
      sitemapindex.sitemap[1].loc[0],
      "https://example.com/sitemap2.xml"
    );
  }

  #[test]
  fn test_parse_sitemap_xml_invalid_root() {
    let xml_content = r#"<?xml version="1.0" encoding="UTF-8"?>
<invalid xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/page1</loc>
  </url>
</invalid>"#;

    let result = parse_sitemap_xml(xml_content);
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("Invalid sitemap format"));
  }

  #[test]
  fn test_parse_sitemap_xml_malformed() {
    let xml_content = r#"<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/page1</loc>
  </url>
</urlset"#; // Missing closing >

    let result = parse_sitemap_xml(xml_content);
    assert!(result.is_err());
  }

  #[test]
  fn test_parse_sitemap_xml_deeply_nested_errors_instead_of_overflowing() {
    let xml_content = format!(
      r#"<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">{}"#,
      "<url><loc>https://example.com/page%3C%2Floc%3E".repeat(50_000)
    );

    let result = parse_sitemap_xml(&xml_content);
    assert!(result.unwrap_err().contains("nested deeper than"));
  }

  #[test]
  fn test_parse_sitemap_xml_deeply_nested_with_quoted_gt_errors() {
    let xml_content = format!(
      r#"<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">{}"#,
      r#"<url data="x/>" other='y>'>"#.repeat(100_000)
    );

    let result = parse_sitemap_xml(&xml_content);
    assert!(result.unwrap_err().contains("nested deeper than"));
  }

  #[test]
  fn test_parse_sitemap_xml_entity_with_nested_markup_errors() {
    let xml_content = format!(
      r#"<!DOCTYPE urlset [<!ENTITY e "{}">]><urlset>&e;</urlset>"#,
      "<url>".repeat(100_000)
    );

    let result = parse_sitemap_xml(&xml_content);
    assert!(result.unwrap_err().contains("entity declarations"));
  }

  #[test]
  fn test_parse_sitemap_xml_with_doctype() {
    let xml_content = r#"<?xml version="1.0"?>
<!DOCTYPE urlset>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/page1</loc></url></urlset>"#;

    let urlset = parse_sitemap_xml(xml_content).unwrap().urlset.unwrap();
    assert_eq!(urlset.url[0].loc[0], "https://example.com/page1");
  }

  #[test]
  fn test_parse_sitemap_xml_with_extensions_comments_and_cdata() {
    let xml_content = r#"<?xml version="1.0" encoding="UTF-8"?>
<!-- generated <by> a plugin -->
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">
  <url>
    <loc><![CDATA[https://example.com/page1]]></loc>
    <image:image><image:loc>https://example.com/a.png</image:loc></image:image>
    <video:video><video:title>t</video:title><video:price currency="USD">1</video:price><video:live/></video:video>
  </url>
  <url><loc>https://example.com/page2</loc></url>
</urlset>"#;

    let urlset = parse_sitemap_xml(xml_content).unwrap().urlset.unwrap();
    assert_eq!(urlset.url.len(), 2);
    assert_eq!(urlset.url[0].loc[0], "https://example.com/page1");
    assert_eq!(urlset.url[1].loc[0], "https://example.com/page2");
  }

  #[test]
  fn test_process_sitemap_urlset() {
    let xml_content = r#"<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/page1</loc>
  </url>
  <url>
    <loc>https://example.com/sitemap2.xml</loc>
  </url>
  <url>
    <loc>https://example.com/image.png</loc>
  </url>
</urlset>"#;

    let result = process_sitemap(xml_content).unwrap();
    assert_eq!(result.instructions.len(), 2);

    let recurse_instruction = result
      .instructions
      .iter()
      .find(|i| i.action == "recurse")
      .unwrap();
    assert_eq!(recurse_instruction.urls.len(), 1);
    assert_eq!(
      recurse_instruction.urls[0],
      "https://example.com/sitemap2.xml"
    );

    let process_instruction = result
      .instructions
      .iter()
      .find(|i| i.action == "process")
      .unwrap();
    assert_eq!(process_instruction.urls.len(), 1);
    assert_eq!(process_instruction.urls[0], "https://example.com/page1");
  }

  #[test]
  fn test_process_sitemap_sitemapindex() {
    let xml_content = r#"<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://example.com/sitemap1.xml</loc>
  </sitemap>
  <sitemap>
    <loc>https://example.com/sitemap2.xml</loc>
  </sitemap>
</sitemapindex>"#;

    let result = process_sitemap(xml_content).unwrap();
    assert_eq!(result.instructions.len(), 1);
    assert_eq!(result.instructions[0].action, "recurse");
    assert_eq!(result.instructions[0].urls.len(), 2);
    assert_eq!(
      result.instructions[0].urls[0],
      "https://example.com/sitemap1.xml"
    );
    assert_eq!(
      result.instructions[0].urls[1],
      "https://example.com/sitemap2.xml"
    );
  }

  #[test]
  fn test_filter_links_normal_robots_txt() {
    let data = FilterLinksCall {
      links: vec![
        "https://example.com/allowed".to_string(),
        "https://example.com/disallowed".to_string(),
      ],
      limit: Some(10),
      includes: vec![],
      excludes: vec![],
      ignore_robots_txt: false,
      robots_txt: "User-agent: *\nDisallow: /disallowed".to_string(),
      max_depth: 10,
      base_url: "https://example.com".to_string(),
      initial_url: "https://example.com".to_string(),
      regex_on_full_url: false,
      allow_backward_crawling: true,
      allow_external_content_links: false,
      allow_subdomains: false,
      robots_user_agent: None,
    };

    let result = _filter_links(data).unwrap();
    assert_eq!(result.links.len(), 1);
    assert_eq!(result.links[0], "https://example.com/allowed");
    assert!(
      result
        .denial_reasons
        .contains_key("https://example.com/disallowed")
    );
    assert_eq!(
      result
        .denial_reasons
        .get("https://example.com/disallowed")
        .unwrap(),
      "ROBOTS_TXT"
    );
  }

  #[test]
  fn test_filter_links_malformed_robots_txt() {
    let data = FilterLinksCall {
      links: vec!["https://example.com/test".to_string()],
      limit: Some(10),
      includes: vec![],
      excludes: vec![],
      ignore_robots_txt: false,
      robots_txt: "Invalid robots.txt content with \x00 null bytes and malformed syntax"
        .to_string(),
      max_depth: 10,
      base_url: "https://example.com".to_string(),
      initial_url: "https://example.com".to_string(),
      regex_on_full_url: false,
      allow_backward_crawling: true,
      allow_external_content_links: false,
      allow_subdomains: false,
      robots_user_agent: None,
    };

    let result = _filter_links(data);
    assert!(result.is_ok());
    let result = result.unwrap();
    assert_eq!(result.links.len(), 1);
    assert_eq!(result.links[0], "https://example.com/test");
  }

  #[test]
  fn test_filter_links_non_utf8_robots_txt() {
    let mut non_utf8_bytes = vec![0xFF, 0xFE];
    non_utf8_bytes.extend_from_slice(b"User-agent: *\nDisallow: /blocked");
    let non_utf8_string = String::from_utf8_lossy(&non_utf8_bytes).to_string();

    let data = FilterLinksCall {
      links: vec!["https://example.com/allowed".to_string()],
      limit: Some(10),
      includes: vec![],
      excludes: vec![],
      ignore_robots_txt: false,
      robots_txt: non_utf8_string,
      max_depth: 10,
      base_url: "https://example.com".to_string(),
      initial_url: "https://example.com".to_string(),
      regex_on_full_url: false,
      allow_backward_crawling: true,
      allow_external_content_links: false,
      allow_subdomains: false,
      robots_user_agent: None,
    };

    let result = _filter_links(data);
    assert!(result.is_ok());
    let result = result.unwrap();
    assert_eq!(result.links.len(), 1);
    assert_eq!(result.links[0], "https://example.com/allowed");
  }

  #[test]
  fn test_filter_links_char_boundary_issue() {
    let problematic_content = "User-agent: *\nDisallow: /\u{a0}test";

    let data = FilterLinksCall {
      links: vec!["https://example.com/test".to_string()],
      limit: Some(10),
      includes: vec![],
      excludes: vec![],
      ignore_robots_txt: false,
      robots_txt: problematic_content.to_string(),
      max_depth: 10,
      base_url: "https://example.com".to_string(),
      initial_url: "https://example.com".to_string(),
      regex_on_full_url: false,
      allow_backward_crawling: true,
      allow_external_content_links: false,
      allow_subdomains: false,
      robots_user_agent: None,
    };

    let result = _filter_links(data);
    assert!(result.is_ok());
    let result = result.unwrap();
    assert_eq!(result.links.len(), 1);
    assert_eq!(result.links[0], "https://example.com/test");
  }

  #[test]
  fn test_filter_links_allow_subdomains_with_include_paths() {
    let data = FilterLinksCall {
      links: vec![
        "https://sub.example.com/pricing".to_string(),
        "https://sub.example.com/blog".to_string(),
        "https://other.example.com/pricing".to_string(),
        "https://example.com/pricing".to_string(),
      ],
      limit: Some(10),
      includes: vec!["^/pricing$".to_string()],
      excludes: vec![],
      ignore_robots_txt: true,
      robots_txt: "".to_string(),
      max_depth: 10,
      base_url: "https://example.com".to_string(),
      initial_url: "https://example.com".to_string(),
      regex_on_full_url: false,
      allow_backward_crawling: true,
      allow_external_content_links: false,
      allow_subdomains: true,
      robots_user_agent: None,
    };

    let result = _filter_links(data).unwrap();
    // Should include only paths matching include on base or subdomains
    assert_eq!(result.links.len(), 3);
    assert!(
      result
        .links
        .contains(&"https://example.com/pricing".to_string())
    );
    assert!(
      result
        .links
        .contains(&"https://sub.example.com/pricing".to_string())
    );
    assert!(
      result
        .links
        .contains(&"https://other.example.com/pricing".to_string())
    );
    // And should exclude blog due to includePaths
    assert!(
      result
        .denial_reasons
        .contains_key("https://sub.example.com/blog")
    );
    assert_eq!(
      result
        .denial_reasons
        .get("https://sub.example.com/blog")
        .unwrap(),
      "INCLUDE_PATTERN"
    );
  }

  #[test]
  fn test_filter_links_honors_custom_robots_user_agent() {
    // robots.txt allows the default FireCrawlAgent but blocks CustomBot. Without
    // a custom user-agent the link is allowed; with `robots_user_agent` wired
    // through it must be filtered.
    let robots_txt = "User-agent: *\nAllow: /\n\nUser-agent: CustomBot\nDisallow: /";

    let base_call = |ua: Option<String>| FilterLinksCall {
      links: vec!["https://example.com/page".to_string()],
      limit: Some(10),
      includes: vec![],
      excludes: vec![],
      ignore_robots_txt: false,
      robots_txt: robots_txt.to_string(),
      max_depth: 10,
      base_url: "https://example.com".to_string(),
      initial_url: "https://example.com".to_string(),
      regex_on_full_url: false,
      allow_backward_crawling: true,
      allow_external_content_links: false,
      allow_subdomains: false,
      robots_user_agent: ua,
    };

    let default_result = _filter_links(base_call(None)).unwrap();
    assert_eq!(default_result.links, vec!["https://example.com/page"]);

    let custom_result = _filter_links(base_call(Some("CustomBot".to_string()))).unwrap();
    assert!(custom_result.links.is_empty());
    assert_eq!(
      custom_result
        .denial_reasons
        .get("https://example.com/page")
        .unwrap(),
      "ROBOTS_TXT"
    );
  }

  #[test]
  fn test_is_file() {
    assert!(is_file("test.png"));
    assert!(is_file("script.js"));
    assert!(is_file("style.css"));
    assert!(!is_file("page"));
    assert!(!is_file("directory/"));
  }

  fn filter_url_call(href: &str, url: &str, base_url: &str) -> FilterUrlCall {
    FilterUrlCall {
      href: href.to_string(),
      url: url.to_string(),
      base_url: base_url.to_string(),
      excludes: vec![],
      ignore_robots_txt: true,
      robots_txt: "".to_string(),
      robots_user_agent: None,
      allow_external_content_links: true,
      allow_subdomains: false,
    }
  }

  // A discovered external link that redirects within its own domain (the
  // redirect target's URL and its source URL are both external to the crawl
  // seed) must be allowed under allowExternalLinks. Regression test for #4315.
  #[test]
  fn test_filter_url_allows_external_link_redirect_same_domain() {
    let result = _filter_url(filter_url_call(
      "http://www.iana.org/help/example-domains",
      "https://iana.org/domains/example",
      "https://example.org",
    ))
    .unwrap();
    assert!(result.allowed);
    assert!(result.denial_reason.is_none());
  }

  // A redirect that stays within the source's registrable domain but changes to
  // a real subdomain must be allowed (PSL-based, not just stripping "www.").
  #[test]
  fn test_filter_url_allows_external_link_redirect_to_subdomain() {
    let result = _filter_url(filter_url_call(
      "https://blog.example.com/post",
      "https://example.com/link",
      "https://crawlseed.org",
    ))
    .unwrap();
    assert!(result.allowed);
  }

  // Same as above but the redirect keeps the exact hostname, only changing the
  // path (the london.gov.uk case from #4315).
  #[test]
  fn test_filter_url_allows_external_link_redirect_same_host_path_change() {
    let result = _filter_url(filter_url_call(
      "https://www.london.gov.uk/programmes-strategies/planning/london-plan",
      "https://www.london.gov.uk/what-we-do/planning/london-plan",
      "https://example.org",
    ))
    .unwrap();
    assert!(result.allowed);
  }

  // An in-scope URL that redirects to an unrelated external homepage stays
  // denied — the external-main-page exclusion is intentional (#4316).
  #[test]
  fn test_filter_url_denies_redirect_to_external_homepage() {
    let result = _filter_url(filter_url_call(
      "https://www.peoplefirstinfo.org.uk/",
      "https://www.westminster.gov.uk/node/21229",
      "https://www.westminster.gov.uk",
    ))
    .unwrap();
    assert!(!result.allowed);
    assert_eq!(result.denial_reason.unwrap(), "EXTERNAL_LINK");
  }

  // A redirect that hops to an unrelated external domain (not the source's own
  // domain, not in scope) remains denied.
  #[test]
  fn test_filter_url_denies_redirect_to_unrelated_external_domain() {
    let result = _filter_url(filter_url_call(
      "https://unrelated.com/article",
      "https://iana.org/domains/example",
      "https://example.org",
    ))
    .unwrap();
    assert!(!result.allowed);
    assert_eq!(result.denial_reason.unwrap(), "EXTERNAL_LINK");
  }
}
