//! Crawl and map, in one process: a frontier, a visited set and a concurrency
//! limit. No queue, no database.

use std::{
  collections::{HashSet, VecDeque},
  sync::Arc,
  time::Duration,
};

use futures::stream::{FuturesUnordered, StreamExt};
use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Value};
use texting_robots::Robot;
use url::Url;

use crate::{
  crawler,
  fetch::FetchOptions,
  scrape::{parse_url, Engine, ScrapeError, ScrapeOptions},
};

/// The token site owners can target in robots.txt.
pub const ROBOTS_AGENT: &str = "FirecrawlLocal";

const SKIP_EXTENSIONS: &[&str] = &[
  "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "tiff", "avif", "css", "js", "mjs",
  "map", "woff", "woff2", "ttf", "otf", "eot", "mp3", "mp4", "m4a", "mov", "avi", "webm", "wav",
  "ogg", "zip", "gz", "tar", "tgz", "bz2", "7z", "rar", "dmg", "exe", "msi", "pkg", "deb", "rpm",
  "apk", "iso", "bin", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "csv", "epub",
];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CrawlOptions {
  /// Maximum pages to return.
  pub limit: usize,
  /// How many links deep to follow from the start URL.
  pub max_discovery_depth: Option<u32>,
  /// Regexes on the URL path; a URL must match one when any are given.
  pub include_paths: Vec<String>,
  /// Regexes on the URL path; a URL matching any is skipped.
  pub exclude_paths: Vec<String>,
  /// Follow links anywhere on the site, not only under the start path.
  pub crawl_entire_domain: bool,
  pub allow_subdomains: bool,
  pub allow_external_links: bool,
  /// "include" (default), "skip" or "only".
  pub sitemap: String,
  pub ignore_robots_txt: bool,
  /// Pages fetched at once.
  pub max_concurrency: Option<usize>,
  /// Milliseconds to wait between requests.
  pub delay: Option<u64>,
  pub scrape_options: ScrapeOptions,
}

impl Default for CrawlOptions {
  fn default() -> Self {
    Self {
      limit: 100,
      max_discovery_depth: None,
      include_paths: Vec::new(),
      exclude_paths: Vec::new(),
      crawl_entire_domain: false,
      allow_subdomains: false,
      allow_external_links: false,
      sitemap: "include".into(),
      ignore_robots_txt: false,
      max_concurrency: None,
      delay: None,
      scrape_options: ScrapeOptions::default(),
    }
  }
}

pub struct CrawlOutcome {
  pub pages: Vec<Value>,
  pub errors: Vec<Value>,
  pub robots_blocked: Vec<String>,
}

fn host_key(host: &str) -> &str {
  host.strip_prefix("www.").unwrap_or(host)
}

fn registrable(host: &str) -> String {
  psl::domain_str(host).unwrap_or(host).to_string()
}

/// Canonical form used for de-duplication: no fragment, no default port,
/// no trailing slash except on the root.
pub fn canonical(url: &Url) -> String {
  let mut u = url.clone();
  u.set_fragment(None);
  let mut s = u.to_string();
  if s.ends_with('/') && u.path() != "/" {
    s.pop();
  }
  s
}

fn has_skipped_extension(url: &Url) -> bool {
  let path = url.path().to_ascii_lowercase();
  match path.rsplit_once('.') {
    Some((_, ext)) if !ext.contains('/') => SKIP_EXTENSIONS.contains(&ext),
    _ => false,
  }
}

/// Directory prefix a crawl stays under when `crawlEntireDomain` is off.
fn scope_prefix(seed: &Url) -> String {
  let path = seed.path();
  if path.ends_with('/') {
    return path.to_string();
  }
  let last = path.rsplit('/').next().unwrap_or("");
  if last.contains('.') {
    // A document: scope to its directory.
    match path.rfind('/') {
      Some(i) => path[..=i].to_string(),
      None => "/".to_string(),
    }
  } else {
    // An extensionless page: the page and its children.
    format!("{path}/")
  }
}

struct Scope {
  seed: Url,
  prefix: String,
  seed_host: String,
  seed_domain: String,
  includes: Vec<Regex>,
  excludes: Vec<Regex>,
  entire_domain: bool,
  allow_subdomains: bool,
  allow_external: bool,
}

impl Scope {
  fn new(seed: &Url, opts: &CrawlOptions) -> Result<Self, ScrapeError> {
    let compile = |patterns: &[String]| -> Result<Vec<Regex>, ScrapeError> {
      patterns
        .iter()
        .map(|p| {
          Regex::new(p).map_err(|e| ScrapeError {
            status: 400,
            code: "BAD_REQUEST",
            message: format!("Invalid path pattern '{p}': {e}"),
          })
        })
        .collect()
    };
    let host = seed.host_str().unwrap_or("").to_ascii_lowercase();
    Ok(Self {
      seed: seed.clone(),
      prefix: scope_prefix(seed),
      seed_host: host_key(&host).to_string(),
      seed_domain: registrable(&host),
      includes: compile(&opts.include_paths)?,
      excludes: compile(&opts.exclude_paths)?,
      entire_domain: opts.crawl_entire_domain,
      allow_subdomains: opts.allow_subdomains,
      allow_external: opts.allow_external_links,
    })
  }

  fn same_site(&self, url: &Url) -> bool {
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    if host_key(&host) == self.seed_host {
      return true;
    }
    self.allow_subdomains && registrable(&host) == self.seed_domain
  }

  fn allows(&self, url: &Url) -> bool {
    if !matches!(url.scheme(), "http" | "https") || has_skipped_extension(url) {
      return false;
    }
    let same_site = self.same_site(url);
    if !same_site && !self.allow_external {
      return false;
    }
    let path = url.path();
    if same_site && !self.entire_domain {
      let seed_path = self.seed.path();
      let under =
        path == seed_path || path.starts_with(&self.prefix) || format!("{path}/") == self.prefix;
      if !under {
        return false;
      }
    }
    if self.excludes.iter().any(|r| r.is_match(path)) {
      return false;
    }
    if !self.includes.is_empty() && !self.includes.iter().any(|r| r.is_match(path)) {
      return false;
    }
    true
  }
}

struct Robots {
  robot: Option<Robot>,
  sitemaps: Vec<String>,
  delay: Option<f32>,
}

async fn load_robots(engine: &Engine, seed: &Url) -> Robots {
  let empty = Robots {
    robot: None,
    sitemaps: Vec::new(),
    delay: None,
  };
  let Ok(robots_url) = seed.join("/robots.txt") else {
    return empty;
  };
  let opts = FetchOptions {
    timeout: Some(Duration::from_secs(10)),
    ..Default::default()
  };
  match engine.fetcher().fetch(&robots_url, &opts).await {
    Ok(res) if (200..300).contains(&res.status) => match Robot::new(ROBOTS_AGENT, &res.body) {
      Ok(robot) => Robots {
        sitemaps: robot.sitemaps.clone(),
        delay: robot.delay,
        robot: Some(robot),
      },
      Err(_) => empty,
    },
    _ => empty,
  }
}

/// URLs listed in the site's sitemaps, following sitemap indexes.
pub async fn sitemap_urls(
  engine: &Engine,
  seed: &Url,
  extra: &[String],
  cap: usize,
) -> Vec<String> {
  let mut queue: VecDeque<String> = VecDeque::new();
  for s in extra {
    queue.push_back(s.clone());
  }
  if let Ok(u) = seed.join("/sitemap.xml") {
    queue.push_back(u.to_string());
  }
  let mut seen_files = HashSet::new();
  let mut out = Vec::new();
  let mut seen_urls = HashSet::new();
  let opts = FetchOptions {
    timeout: Some(Duration::from_secs(15)),
    ..Default::default()
  };
  while let Some(sitemap) = queue.pop_front() {
    if seen_files.len() >= 50 || out.len() >= cap {
      break;
    }
    if !seen_files.insert(sitemap.clone()) {
      continue;
    }
    let Ok(url) = Url::parse(&sitemap) else {
      continue;
    };
    let Ok(res) = engine.fetcher().fetch(&url, &opts).await else {
      continue;
    };
    if !(200..300).contains(&res.status) {
      continue;
    }
    let Ok(processed) = crawler::process_sitemap(res.text()).await else {
      continue;
    };
    for instruction in processed.instructions {
      if instruction.action == "recurse" {
        for u in instruction.urls {
          queue.push_back(u);
        }
      } else {
        for u in instruction.urls {
          if out.len() >= cap {
            break;
          }
          if seen_urls.insert(u.clone()) {
            out.push(u);
          }
        }
      }
    }
  }
  out
}

/// Crawl from `start`. `on_page` runs as each page finishes, so callers can
/// stream results or write files while the crawl is still going.
pub async fn crawl<F>(
  engine: Arc<Engine>,
  start: &str,
  opts: &CrawlOptions,
  mut on_page: F,
) -> Result<CrawlOutcome, ScrapeError>
where
  F: FnMut(&Value),
{
  let seed = parse_url(start)?;
  let scope = Scope::new(&seed, opts)?;
  let limit = opts.limit.max(1);
  let max_depth = opts.max_discovery_depth.unwrap_or(u32::MAX);
  let robots = if opts.ignore_robots_txt {
    Robots {
      robot: None,
      sitemaps: Vec::new(),
      delay: None,
    }
  } else {
    load_robots(&engine, &seed).await
  };

  // robots.txt Crawl-delay means one request at a time, spaced out.
  let robots_delay = robots
    .delay
    .map(|d| Duration::from_secs_f32(d.clamp(0.0, 30.0)));
  let delay = opts.delay.map(Duration::from_millis).or(robots_delay);
  let concurrency = if delay.is_some() {
    1
  } else {
    opts.max_concurrency.unwrap_or(8).clamp(1, 64)
  };

  let mut frontier: VecDeque<(Url, u32)> = VecDeque::new();
  let mut visited: HashSet<String> = HashSet::new();
  let mut robots_blocked = Vec::new();

  let enqueue = |url: Url,
                 depth: u32,
                 frontier: &mut VecDeque<(Url, u32)>,
                 visited: &mut HashSet<String>,
                 blocked: &mut Vec<String>| {
    let key = canonical(&url);
    if visited.contains(&key) {
      return;
    }
    if let Some(robot) = &robots.robot {
      if !robot.allowed(url.as_str()) {
        visited.insert(key);
        blocked.push(url.to_string());
        return;
      }
    }
    visited.insert(key);
    frontier.push_back((url, depth));
  };

  if opts.sitemap != "only" {
    enqueue(
      seed.clone(),
      0,
      &mut frontier,
      &mut visited,
      &mut robots_blocked,
    );
  }
  if opts.sitemap != "skip" {
    let urls = sitemap_urls(&engine, &seed, &robots.sitemaps, limit * 4).await;
    for u in urls {
      if let Ok(parsed) = Url::parse(&u) {
        if scope.allows(&parsed) {
          enqueue(parsed, 1, &mut frontier, &mut visited, &mut robots_blocked);
        }
      }
    }
  }

  let mut pages: Vec<Value> = Vec::new();
  let mut errors: Vec<Value> = Vec::new();
  let mut in_flight = FuturesUnordered::new();
  let mut started = 0usize;

  loop {
    while in_flight.len() < concurrency && started < limit {
      let Some((url, depth)) = frontier.pop_front() else {
        break;
      };
      started += 1;
      let engine = engine.clone();
      let scrape_opts = opts.scrape_options.clone();
      in_flight.push(async move {
        if let Some(d) = delay {
          tokio::time::sleep(d).await;
        }
        let res = engine.scrape_with_links(url.as_str(), &scrape_opts).await;
        (url, depth, res)
      });
    }
    let Some((url, depth, res)) = in_flight.next().await else {
      break;
    };
    match res {
      Ok((doc, links)) => {
        on_page(&doc);
        pages.push(doc);
        if depth < max_depth && opts.sitemap != "only" {
          for link in links {
            if let Ok(parsed) = Url::parse(&link) {
              if scope.allows(&parsed) {
                enqueue(
                  parsed,
                  depth + 1,
                  &mut frontier,
                  &mut visited,
                  &mut robots_blocked,
                );
              }
            }
          }
        }
      }
      Err(e) => {
        // A failed page does not count against the limit.
        started -= 1;
        errors.push(json!({ "url": url.to_string(), "code": e.code, "error": e.message }));
      }
    }
  }

  Ok(CrawlOutcome {
    pages,
    errors,
    robots_blocked,
  })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MapOptions {
  pub search: Option<String>,
  pub limit: usize,
  pub include_subdomains: bool,
  /// "include" (default), "skip" or "only".
  pub sitemap: String,
}

impl Default for MapOptions {
  fn default() -> Self {
    Self {
      search: None,
      limit: 5000,
      include_subdomains: true,
      sitemap: "include".into(),
    }
  }
}

/// Every URL the engine can find for a site without crawling it: the
/// sitemaps plus the links on the start page.
pub async fn map(
  engine: Arc<Engine>,
  start: &str,
  opts: &MapOptions,
) -> Result<Vec<String>, ScrapeError> {
  let seed = parse_url(start)?;
  let host = seed.host_str().unwrap_or("").to_ascii_lowercase();
  let seed_host = host_key(&host).to_string();
  let seed_domain = registrable(&host);
  let limit = opts.limit.clamp(1, 100_000);

  let robots = load_robots(&engine, &seed).await;
  let mut candidates: Vec<String> = Vec::new();

  if opts.sitemap != "skip" {
    candidates.extend(sitemap_urls(&engine, &seed, &robots.sitemaps, limit * 2).await);
  }
  if opts.sitemap != "only" {
    let page_opts = ScrapeOptions {
      formats: vec![Value::String("links".into())],
      ..Default::default()
    };
    if let Ok((_, links)) = engine.scrape_with_links(seed.as_str(), &page_opts).await {
      candidates.push(seed.to_string());
      candidates.extend(links);
    }
  }

  let needle = opts.search.as_ref().map(|s| s.to_ascii_lowercase());
  let mut seen = HashSet::new();
  let mut out = Vec::new();
  for c in candidates {
    let Ok(url) = Url::parse(&c) else { continue };
    if !matches!(url.scheme(), "http" | "https") {
      continue;
    }
    let h = url.host_str().unwrap_or("").to_ascii_lowercase();
    let on_site =
      host_key(&h) == seed_host || (opts.include_subdomains && registrable(&h) == seed_domain);
    if !on_site {
      continue;
    }
    let key = canonical(&url);
    if let Some(n) = &needle {
      if !key.to_ascii_lowercase().contains(n) {
        continue;
      }
    }
    if seen.insert(key.clone()) {
      out.push(key);
      if out.len() >= limit {
        break;
      }
    }
  }
  Ok(out)
}

fn file_name_for(url: &str, index: usize) -> String {
  let slug: String = url
    .trim_start_matches("https://")
    .trim_start_matches("http://")
    .chars()
    .map(|c| {
      if c.is_ascii_alphanumeric() || c == '-' || c == '.' {
        c
      } else {
        '_'
      }
    })
    .collect();
  let slug = slug.trim_matches('_');
  let slug = if slug.len() > 120 { &slug[..120] } else { slug };
  format!("{:04}-{slug}.md", index + 1)
}

/// A value on one line: control characters, tabs and line breaks included,
/// become spaces, so it cannot break a line-based or tab-separated record.
fn one_line(value: &str) -> String {
  value
    .chars()
    .map(|c| if c.is_control() { ' ' } else { c })
    .collect::<String>()
    .trim()
    .to_string()
}

/// A value as a double-quoted YAML scalar. A JSON string is one, and quoting
/// keeps a title such as "Docs: Setup" from being read as a mapping.
fn yaml_string(value: &str) -> String {
  serde_json::to_string(&one_line(value)).unwrap_or_else(|_| "\"\"".to_string())
}

/// Write one markdown file per page and return an index of "file  url  title".
pub async fn write_pages(dir: &std::path::Path, pages: &[Value]) -> Result<Vec<String>, String> {
  tokio::fs::create_dir_all(dir)
    .await
    .map_err(|e| format!("{}: {e}", dir.display()))?;
  let mut index = Vec::new();
  for (i, page) in pages.iter().enumerate() {
    let url = page
      .pointer("/metadata/url")
      .and_then(Value::as_str)
      .unwrap_or("");
    let title = page
      .pointer("/metadata/title")
      .and_then(Value::as_str)
      .unwrap_or("");
    let md = page.get("markdown").and_then(Value::as_str).unwrap_or("");
    let name = file_name_for(url, i);
    let body = format!(
      "---\nurl: {}\ntitle: {}\n---\n\n{md}\n",
      yaml_string(url),
      yaml_string(title)
    );
    tokio::fs::write(dir.join(&name), body)
      .await
      .map_err(|e| format!("{name}: {e}"))?;
    index.push(format!("{name}\t{}\t{}", one_line(url), one_line(title)));
  }
  Ok(index)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn scope(seed: &str, opts: CrawlOptions) -> Scope {
    Scope::new(&Url::parse(seed).unwrap(), &opts).unwrap()
  }

  fn u(s: &str) -> Url {
    Url::parse(s).unwrap()
  }

  #[tokio::test]
  async fn a_page_title_cannot_break_the_front_matter_or_the_index() {
    let dir = std::env::temp_dir().join(format!("fc-local-pages-{}", uuid::Uuid::new_v4()));
    let pages = vec![serde_json::json!({
      "markdown": "body",
      "metadata": {
        "url": "https://example.com/a",
        "title": "Docs: Setup\ninjected: yes\tand \"quotes\" # not a comment"
      }
    })];
    let index = write_pages(&dir, &pages).await.unwrap();
    assert_eq!(index.len(), 1);
    assert_eq!(index[0].split('\t').count(), 3, "{}", index[0]);
    assert!(!index[0].contains('\n'));
    let name = index[0].split('\t').next().unwrap();
    let written = tokio::fs::read_to_string(dir.join(name)).await.unwrap();
    let _ = tokio::fs::remove_dir_all(&dir).await;
    let front: Vec<&str> = written.split("---\n").nth(1).unwrap().lines().collect();
    assert_eq!(front.len(), 2, "{written}");
    assert_eq!(front[0], "url: \"https://example.com/a\"");
    assert_eq!(
      front[1],
      "title: \"Docs: Setup injected: yes and \\\"quotes\\\" # not a comment\""
    );
  }

  #[test]
  fn stays_under_start_path_by_default() {
    let s = scope("https://example.com/docs/", CrawlOptions::default());
    assert!(s.allows(&u("https://example.com/docs/intro")));
    assert!(s.allows(&u("https://www.example.com/docs/a/b")));
    assert!(!s.allows(&u("https://example.com/blog/post")));
    assert!(!s.allows(&u("https://other.com/docs/intro")));
    assert!(!s.allows(&u("https://sub.example.com/docs/intro")));
  }

  #[test]
  fn document_seed_scopes_to_directory() {
    let s = scope(
      "https://example.com/docs/index.html",
      CrawlOptions::default(),
    );
    assert!(s.allows(&u("https://example.com/docs/other.html")));
    assert!(!s.allows(&u("https://example.com/about.html")));
  }

  #[test]
  fn extensionless_seed_allows_itself_and_children() {
    let s = scope("https://example.com/docs", CrawlOptions::default());
    assert!(s.allows(&u("https://example.com/docs")));
    assert!(s.allows(&u("https://example.com/docs/a")));
    assert!(!s.allows(&u("https://example.com/docs-old/a")));
  }

  #[test]
  fn entire_domain_subdomains_and_patterns() {
    let s = scope(
      "https://example.com/docs/",
      CrawlOptions {
        crawl_entire_domain: true,
        allow_subdomains: true,
        exclude_paths: vec!["^/private".into()],
        ..Default::default()
      },
    );
    assert!(s.allows(&u("https://example.com/blog/post")));
    assert!(s.allows(&u("https://sub.example.com/x")));
    assert!(!s.allows(&u("https://example.com/private/x")));
    assert!(!s.allows(&u("https://example.com/logo.png")));
    assert!(!s.allows(&u("mailto:a@example.com")));
  }

  #[test]
  fn canonical_drops_fragment_and_trailing_slash() {
    assert_eq!(canonical(&u("https://a.dev/x/#top")), "https://a.dev/x");
    assert_eq!(canonical(&u("https://a.dev/")), "https://a.dev/");
  }
}
