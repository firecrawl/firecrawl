//! One URL in, one Firecrawl-shaped document out.

use std::{collections::HashMap, sync::Arc, time::Duration};

use serde::Deserialize;
use serde_json::{json, Map, Value};
use url::Url;

use crate::{
  browser::{looks_like_nav_only_shell, meta_refresh_target, needs_browser, BrowserPool},
  fetch::{FetchError, FetchOptions, Fetcher},
  guard::NetworkPolicy,
  html::{self, TransformHtmlOptions},
  markdown,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Format {
  Markdown,
  Html,
  RawHtml,
  Links,
  Screenshot,
}

impl Format {
  pub fn parse(name: &str) -> Option<Format> {
    match name {
      "markdown" => Some(Format::Markdown),
      "html" => Some(Format::Html),
      "rawHtml" | "raw_html" | "rawhtml" => Some(Format::RawHtml),
      "links" => Some(Format::Links),
      "screenshot" | "screenshot@fullPage" => Some(Format::Screenshot),
      _ => None,
    }
  }
}

/// The subset of Firecrawl's scrape options the local engine honours. Unknown
/// fields are accepted and ignored so existing clients keep working.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ScrapeOptions {
  pub formats: Vec<Value>,
  pub only_main_content: bool,
  pub include_tags: Vec<String>,
  pub exclude_tags: Vec<String>,
  /// Milliseconds, as in the Firecrawl API.
  pub timeout: Option<u64>,
  pub headers: HashMap<String, String>,
  /// Milliseconds to wait after the page loads. Uses the local browser.
  pub wait_for: Option<u64>,
}

impl Default for ScrapeOptions {
  fn default() -> Self {
    Self {
      formats: vec![Value::String("markdown".into())],
      only_main_content: true,
      include_tags: Vec::new(),
      exclude_tags: Vec::new(),
      timeout: None,
      headers: HashMap::new(),
      wait_for: None,
    }
  }
}

impl ScrapeOptions {
  /// Formats the engine can produce locally, and the names of any it cannot.
  pub fn resolved_formats(&self) -> (Vec<Format>, Vec<String>) {
    let mut known = Vec::new();
    let mut unknown = Vec::new();
    for f in &self.formats {
      let name = match f {
        Value::String(s) => s.clone(),
        Value::Object(o) => o
          .get("type")
          .and_then(Value::as_str)
          .unwrap_or("")
          .to_string(),
        _ => String::new(),
      };
      match Format::parse(&name) {
        Some(fmt) if !known.contains(&fmt) => known.push(fmt),
        Some(_) => {}
        None if !name.is_empty() => unknown.push(name),
        None => {}
      }
    }
    if known.is_empty() && unknown.is_empty() {
      known.push(Format::Markdown);
    }
    (known, unknown)
  }
}

#[derive(Debug)]
pub struct ScrapeError {
  pub status: u16,
  pub code: &'static str,
  pub message: String,
}

impl ScrapeError {
  fn new(status: u16, code: &'static str, message: impl Into<String>) -> Self {
    Self {
      status,
      code,
      message: message.into(),
    }
  }
}

impl std::fmt::Display for ScrapeError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    write!(f, "{}", self.message)
  }
}

impl From<FetchError> for ScrapeError {
  fn from(e: FetchError) -> Self {
    match e {
      FetchError::Blocked(m) => ScrapeError::new(403, "BLOCKED_TARGET", m),
      FetchError::Timeout => ScrapeError::new(408, "SCRAPE_TIMEOUT", "The scrape timed out."),
      FetchError::TooLarge => ScrapeError::new(413, "RESPONSE_TOO_LARGE", e.to_string()),
      FetchError::Network(m) => ScrapeError::new(502, "FETCH_FAILED", m),
    }
  }
}

/// When to use the local browser.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BrowserMode {
  /// Plain fetch first; the browser only for pages that come back as an
  /// empty JavaScript shell, or when a screenshot or wait is asked for.
  Auto,
  Never,
  Always,
}

pub struct EngineConfig {
  pub policy: NetworkPolicy,
  pub user_agent: Option<String>,
  pub browser: BrowserMode,
}

pub struct Engine {
  fetcher: Fetcher,
  browser: Option<Arc<BrowserPool>>,
  browser_mode: BrowserMode,
  in_flight: std::sync::atomic::AtomicUsize,
  dirty: std::sync::atomic::AtomicBool,
  parse_slots: tokio::sync::Semaphore,
}

struct InFlight<'a>(&'a Engine);

impl Drop for InFlight<'_> {
  fn drop(&mut self) {
    use std::sync::atomic::Ordering;
    self.0.in_flight.fetch_sub(1, Ordering::SeqCst);
    self.0.dirty.store(true, Ordering::SeqCst);
  }
}

/// Add a warning to a document, keeping any that is already there.
pub fn add_warning(data: &mut Map<String, Value>, text: impl Into<String>) {
  let text = text.into();
  let joined = match data.get("warning").and_then(Value::as_str) {
    Some(existing) if !existing.is_empty() => format!("{existing} {text}"),
    _ => text,
  };
  data.insert("warning".into(), Value::String(joined));
}

/// What to say when a page needs JavaScript and was not rendered, so a
/// near-empty result is not mistaken for the whole page. `None` when the
/// browser was turned off on purpose or did its job.
fn browser_warning(mode: BrowserMode, has_browser: bool, render: &Render) -> Option<String> {
  if mode == BrowserMode::Never {
    return None;
  }
  let lead = "This page builds its content with JavaScript, so this result is probably incomplete.";
  match (has_browser, render) {
    (false, _) => Some(format!(
      "{lead} No Chrome or Chromium was found on this machine. Install one, or point FIRECRAWL_CHROME_PATH at it."
    )),
    (true, Render::Failed(error)) => {
      Some(format!("{lead} The local Chrome could not render it. {error}"))
    }
    (true, Render::Rejected) => Some(format!(
      "{lead} The local Chrome loaded it but came back with less text than the plain fetch, as a consent wall or a half-loaded page does, so the plain fetch was kept."
    )),
    (true, Render::NotNeeded) => None,
  }
}

/// How the browser fared on a page that looked like it needed one.
enum Render {
  /// It was not asked, or its result was used.
  NotNeeded,
  /// It could not load the page.
  Failed(String),
  /// It loaded the page, and what it got was worse than the plain fetch.
  Rejected,
}

fn looks_like_html(mime: Option<&str>, body: &[u8]) -> bool {
  match mime {
    Some("text/html") | Some("application/xhtml+xml") => true,
    Some(m) if m.starts_with("text/") || m.contains("json") || m.contains("xml") => {
      // Mislabelled HTML is common; trust the first bytes over the header.
      sniff_html(body) && !m.contains("json")
    }
    Some(_) => false,
    None => sniff_html(body),
  }
}

fn sniff_html(body: &[u8]) -> bool {
  let head = String::from_utf8_lossy(&body[..body.len().min(1024)]).to_ascii_lowercase();
  let head = head.trim_start();
  head.starts_with("<!doctype html") || head.starts_with("<html") || head.contains("<head")
}

fn resolve_links(hrefs: Vec<String>, base: &Url) -> Vec<String> {
  let mut seen = std::collections::HashSet::new();
  let mut out = Vec::new();
  for href in hrefs {
    let href = href.trim();
    if href.is_empty() || href.starts_with('#') {
      continue;
    }
    let lower = href.to_ascii_lowercase();
    if lower.starts_with("javascript:") || lower.starts_with("data:") {
      continue;
    }
    let resolved = match base.join(href) {
      Ok(u) => u,
      Err(_) => continue,
    };
    if !matches!(resolved.scheme(), "http" | "https" | "mailto" | "tel") {
      continue;
    }
    let s = resolved.to_string();
    if seen.insert(s.clone()) {
      out.push(s);
    }
  }
  out
}

impl Engine {
  pub fn new(cfg: EngineConfig) -> Result<Self, String> {
    let user_agent = cfg
      .user_agent
      .clone()
      .unwrap_or_else(|| crate::fetch::USER_AGENT.to_string());
    let browser = match cfg.browser {
      BrowserMode::Never => None,
      _ => BrowserPool::new(cfg.policy, &user_agent, 6),
    };
    Ok(Self {
      fetcher: Fetcher::new(cfg.policy, cfg.user_agent.as_deref())?,
      browser,
      browser_mode: cfg.browser,
      in_flight: std::sync::atomic::AtomicUsize::new(0),
      dirty: std::sync::atomic::AtomicBool::new(false),
      parse_slots: tokio::sync::Semaphore::new(
        std::thread::available_parallelism()
          .map(|n| n.get())
          .unwrap_or(4),
      ),
    })
  }

  pub fn policy(&self) -> NetworkPolicy {
    self.fetcher.policy()
  }

  pub fn fetcher(&self) -> &Fetcher {
    &self.fetcher
  }

  /// True when a Chromium-family browser was found for JavaScript pages.
  pub fn has_browser(&self) -> bool {
    self.browser.is_some()
  }

  /// Run for the life of a long-lived process (`serve`, `mcp`): whenever the
  /// engine goes idle after doing work, hand freed memory back to the system.
  pub async fn trim_memory_when_idle(self: Arc<Self>) {
    use std::sync::atomic::Ordering;
    loop {
      tokio::time::sleep(Duration::from_secs(2)).await;
      if self.in_flight.load(Ordering::SeqCst) == 0 && self.dirty.swap(false, Ordering::SeqCst) {
        let _ = tokio::task::spawn_blocking(crate::mem::release_free_memory).await;
      }
    }
  }

  /// Stop the browser, if one was started.
  pub async fn shutdown(&self) {
    if let Some(b) = &self.browser {
      b.shutdown().await;
    }
  }

  /// Scrape one URL and also return every link on the page, resolved against
  /// the page's base URL. The crawler uses this to avoid parsing twice.
  pub async fn scrape_with_links(
    &self,
    url: &str,
    opts: &ScrapeOptions,
  ) -> Result<(Value, Vec<String>), ScrapeError> {
    let mut with_links = opts.clone();
    let asked_for_links = opts.resolved_formats().0.contains(&Format::Links);
    if !asked_for_links {
      with_links.formats.push(Value::String("links".into()));
    }
    let mut data = self.scrape(url, &with_links).await?;
    let links: Vec<String> = data
      .get("links")
      .and_then(Value::as_array)
      .map(|a| {
        a.iter()
          .filter_map(|v| v.as_str().map(str::to_string))
          .collect()
      })
      .unwrap_or_default();
    if !asked_for_links {
      if let Some(obj) = data.as_object_mut() {
        obj.remove("links");
      }
    }
    Ok((data, links))
  }

  /// Scrape one URL and return the `data` object of a Firecrawl scrape
  /// response.
  pub async fn scrape(&self, url: &str, opts: &ScrapeOptions) -> Result<Value, ScrapeError> {
    self
      .in_flight
      .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let _in_flight = InFlight(self);
    let parsed = parse_url(url)?;
    let (formats, mut unsupported) = opts.resolved_formats();
    let timeout = Duration::from_millis(opts.timeout.unwrap_or(30_000));
    let wait_for = Duration::from_millis(opts.wait_for.unwrap_or(0).min(30_000));
    let wants_screenshot = formats.contains(&Format::Screenshot);
    if wants_screenshot && self.browser.is_none() {
      unsupported.push("screenshot (no Chrome found on this machine)".into());
    }

    let must_render = self.browser.is_some()
      && (self.browser_mode == BrowserMode::Always || wants_screenshot || !wait_for.is_zero());

    let mut data = if must_render {
      self
        .render_document(&parsed, opts, &formats, wait_for, timeout, wants_screenshot)
        .await?
    } else {
      let fetch_opts = FetchOptions {
        headers: opts.headers.clone(),
        timeout: Some(timeout),
      };
      let can_render = self.browser_mode == BrowserMode::Auto && self.browser.is_some();
      let mut target = parsed.clone();
      let mut hops = 0;
      let fetched = loop {
        let fetched = match self.fetcher.fetch(&target, &fetch_opts).await {
          Ok(f) => f,
          // A plain fetch that fails at the network level (reset, protocol
          // error, timeout) often works in a real browser.
          Err(e @ (FetchError::Network(_) | FetchError::Timeout)) if can_render => {
            match self
              .render_document(&parsed, opts, &formats, wait_for, timeout, false)
              .await
            {
              Ok(mut doc) => {
                if !unsupported.is_empty() {
                  doc.insert(
                    "warning".into(),
                    Value::String(format!(
                      "These formats are not produced by the local engine and were skipped: {}.",
                      unsupported.join(", ")
                    )),
                  );
                }
                return Ok(Value::Object(doc));
              }
              Err(_) => return Err(e.into()),
            }
          }
          Err(e) => return Err(e.into()),
        };
        // Follow an instant <meta refresh> the way a browser would.
        let next = if hops < 3 && looks_like_html(fetched.mime().as_deref(), &fetched.body) {
          meta_refresh_target(&fetched.text(), &fetched.final_url)
        } else {
          None
        };
        match next {
          Some(url) => {
            hops += 1;
            target = url;
          }
          None => break fetched,
        }
      };
      let mime = fetched.mime();
      if let Some(kind) =
        crate::documents::sniff(&fetched.body, mime.as_deref(), &fetched.final_url)
      {
        let body = fetched.body.clone();
        let parsed_doc = tokio::task::spawn_blocking(move || {
          let label = match kind {
            crate::documents::DocKind::Pdf => "local-pdf",
            crate::documents::DocKind::Office(_) => "local-document",
          };
          crate::documents::parse(&kind, &body).map(|d| (d, label))
        })
        .await
        .map_err(|e| ScrapeError::new(500, "PARSE_FAILED", e.to_string()))?
        .map_err(|e| ScrapeError::new(422, "DOCUMENT_PARSE_FAILED", e))?;
        let (doc, label) = parsed_doc;
        let mut data = Map::new();
        let mut metadata = Map::new();
        if let Some(title) = &doc.title {
          metadata.insert("title".into(), Value::String(title.clone()));
        }
        if let Some(pages) = doc.pages {
          metadata.insert("numPages".into(), json!(pages));
        }
        if doc.pages_needing_ocr > 0 {
          data.insert(
            "warning".into(),
            Value::String(format!(
              "{} page(s) of this PDF are scanned images; the local engine has no OCR, so their text is missing.",
              doc.pages_needing_ocr
            )),
          );
        }
        if formats.contains(&Format::Markdown) {
          data.insert("markdown".into(), Value::String(doc.markdown));
        }
        finish_metadata(
          &mut metadata,
          &parsed,
          fetched.final_url.as_str(),
          fetched.status,
          fetched.content_type.as_deref(),
          label,
        );
        data.insert("metadata".into(), Value::Object(metadata));
        data
      } else if looks_like_html(mime.as_deref(), &fetched.body) {
        let raw_html = fetched.text();
        let (mut data, mut metadata, markdown) = self
          .html_parts(raw_html.clone(), &fetched.final_url, opts, &formats)
          .await?;
        // A bot check (a 403 or 503, a "verifying your browser" page) often
        // clears in a real browser. Keep what the browser got only when it is
        // real content, so a page that stays blocked still reads as blocked.
        let challenged = can_render
          && (matches!(fetched.status, 403 | 503) || crate::cloud::looks_like_bot_check(&markdown));
        let nav_only = looks_like_nav_only_shell(&raw_html, &markdown);
        let needs_javascript =
          (200..400).contains(&fetched.status) && (needs_browser(&raw_html, &markdown) || nav_only);
        let shell = can_render && !challenged && needs_javascript;
        let mut render = Render::NotNeeded;
        let rendered = if challenged {
          match self
            .render_with_markdown(&parsed, opts, &formats, wait_for, timeout, false)
            .await
          {
            Ok((doc, rendered_md))
              if !crate::cloud::looks_like_bot_check(&rendered_md)
                && visible_chars(&rendered_md) > visible_chars(&markdown).max(200) =>
            {
              Some(doc)
            }
            _ => None,
          }
        } else if shell {
          // Keep the render unless it came back with clearly less text than
          // the plain fetch had (a consent wall, a half-loaded page).
          match self
            .render_with_markdown(&parsed, opts, &formats, wait_for, timeout, false)
            .await
          {
            Ok((doc, rendered_md))
              if nav_only || visible_chars(&rendered_md) * 10 >= visible_chars(&markdown) * 8 =>
            {
              Some(doc)
            }
            Ok(_) => {
              render = Render::Rejected;
              None
            }
            Err(e) => {
              render = Render::Failed(e.message);
              None
            }
          }
        } else {
          None
        };
        match rendered {
          Some(doc) => doc,
          None => {
            if needs_javascript && !challenged {
              if let Some(warning) =
                browser_warning(self.browser_mode, self.browser.is_some(), &render)
              {
                add_warning(&mut data, warning);
              }
            }
            finish_metadata(
              &mut metadata,
              &parsed,
              fetched.final_url.as_str(),
              fetched.status,
              fetched.content_type.as_deref(),
              "local-fetch",
            );
            data.insert("metadata".into(), Value::Object(metadata));
            data
          }
        }
      } else if mime
        .as_deref()
        .map(|m| m.starts_with("text/") || m.contains("json") || m.contains("xml"))
        .unwrap_or(false)
      {
        let text = fetched.text();
        let mut data = Map::new();
        if formats.contains(&Format::Markdown) {
          data.insert("markdown".into(), Value::String(text.clone()));
        }
        if formats.contains(&Format::RawHtml) {
          data.insert("rawHtml".into(), Value::String(text));
        }
        let mut metadata = Map::new();
        finish_metadata(
          &mut metadata,
          &parsed,
          fetched.final_url.as_str(),
          fetched.status,
          fetched.content_type.as_deref(),
          "local-fetch",
        );
        data.insert("metadata".into(), Value::Object(metadata));
        data
      } else {
        return Err(ScrapeError::new(
          415,
          "UNSUPPORTED_CONTENT_TYPE",
          format!(
            "The local engine does not parse '{}' yet.",
            mime.as_deref().unwrap_or("unknown content type")
          ),
        ));
      }
    };

    if !unsupported.is_empty() {
      add_warning(
        &mut data,
        format!(
          "These formats are not produced by the local engine and were skipped: {}.",
          unsupported.join(", ")
        ),
      );
    }
    Ok(Value::Object(data))
  }

  /// Load the page in the local browser and build the document from what it
  /// rendered.
  async fn render_document(
    &self,
    requested: &Url,
    opts: &ScrapeOptions,
    formats: &[Format],
    wait_for: Duration,
    timeout: Duration,
    screenshot: bool,
  ) -> Result<Map<String, Value>, ScrapeError> {
    self
      .render_with_markdown(requested, opts, formats, wait_for, timeout, screenshot)
      .await
      .map(|(data, _)| data)
  }

  /// `render_document`, plus the page's markdown even when markdown was not
  /// a requested format, so the caller can judge what the browser got.
  async fn render_with_markdown(
    &self,
    requested: &Url,
    opts: &ScrapeOptions,
    formats: &[Format],
    wait_for: Duration,
    timeout: Duration,
    screenshot: bool,
  ) -> Result<(Map<String, Value>, String), ScrapeError> {
    let browser = self
      .browser
      .as_ref()
      .ok_or_else(|| ScrapeError::new(501, "NO_BROWSER", "No Chrome was found on this machine."))?;
    let rendered = browser
      .render(
        requested,
        wait_for,
        timeout.max(Duration::from_secs(10)),
        screenshot,
      )
      .await
      .map_err(|m| {
        if m.contains("private") || m.contains("never reachable") || m.contains("local hostname") {
          ScrapeError::new(403, "BLOCKED_TARGET", m)
        } else {
          ScrapeError::new(502, "RENDER_FAILED", m)
        }
      })?;
    let final_url = Url::parse(&rendered.final_url).unwrap_or_else(|_| requested.clone());
    let (mut data, mut metadata, markdown) = self
      .html_parts(rendered.html, &final_url, opts, formats)
      .await?;
    if let Some(png) = rendered.screenshot_png {
      use base64::Engine as _;
      let encoded = base64::engine::general_purpose::STANDARD.encode(png);
      data.insert(
        "screenshot".into(),
        Value::String(format!("data:image/png;base64,{encoded}")),
      );
    }
    finish_metadata(
      &mut metadata,
      requested,
      final_url.as_str(),
      rendered.status.unwrap_or(200),
      Some("text/html"),
      "local-browser",
    );
    data.insert("metadata".into(), Value::Object(metadata));
    Ok((data, markdown))
  }

  /// Turn one HTML document into the requested formats. Also returns the
  /// markdown (even when not requested as a format) so the caller can tell an
  /// empty JavaScript shell from a real page.
  ///
  /// The page is parsed once. Metadata, links, cleaning and markdown all run
  /// on that one tree, on a single blocking thread.
  async fn html_parts(
    &self,
    raw_html: String,
    final_url: &Url,
    opts: &ScrapeOptions,
    formats: &[Format],
  ) -> Result<(Map<String, Value>, Map<String, Value>, String), ScrapeError> {
    let final_url = final_url.clone();
    let opts = opts.clone();
    let formats = formats.to_vec();
    // Parsing is CPU-bound: more pages in memory than cores only raises the
    // peak, not the throughput.
    let _permit = self
      .parse_slots
      .acquire()
      .await
      .map_err(|e| ScrapeError::new(500, "PARSE_FAILED", e.to_string()))?;
    tokio::task::spawn_blocking(move || process_html(raw_html, &final_url, &opts, &formats))
      .await
      .map_err(|e| ScrapeError::new(500, "PARSE_FAILED", e.to_string()))?
  }
}

fn process_html(
  raw_html: String,
  final_url: &Url,
  opts: &ScrapeOptions,
  formats: &[Format],
) -> Result<(Map<String, Value>, Map<String, Value>, String), ScrapeError> {
  use kuchikiki::traits::TendrilSink;
  let parse_err = |e: Box<dyn std::error::Error + Send + Sync>| {
    ScrapeError::new(500, "PARSE_FAILED", e.to_string())
  };
  let mut data = Map::new();
  let mut metadata: Map<String, Value> = Map::new();

  let document = kuchikiki::parse_html().one(raw_html.as_str());

  // Read-only passes first, on the page as it was served.
  for (k, v) in html::extract_metadata_from_document(&document).map_err(parse_err)? {
    metadata.insert(k, v);
  }
  if formats.contains(&Format::Links) {
    let base = Url::parse(&html::base_href_of_document(&document, final_url))
      .unwrap_or_else(|_| final_url.clone());
    let hrefs = html::extract_links_from_document(&document)
      .map_err(|e| ScrapeError::new(500, "PARSE_FAILED", e))?;
    data.insert("links".into(), json!(resolve_links(hrefs, &base)));
  }

  // Then the passes that change the tree.
  let prose_before = if opts.only_main_content {
    paragraph_chars(&document)
  } else {
    0
  };
  if opts.only_main_content {
    keep_content_headers(&document);
    strip_page_furniture(&document);
  }
  let transform = |document: kuchikiki::NodeRef, only_main: bool, extra_excludes: &[&str]| {
    let mut exclude_tags = opts.exclude_tags.clone();
    exclude_tags.extend(extra_excludes.iter().map(|s| s.to_string()));
    html::transform_document(
      document,
      &TransformHtmlOptions {
        html: String::new(),
        url: final_url.to_string(),
        include_tags: opts.include_tags.clone(),
        exclude_tags,
        only_main_content: only_main,
        omce_signatures: None,
      },
    )
  };
  let mut cleaned = transform(document, opts.only_main_content, &[]).map_err(parse_err)?;

  // Safety net: when the main-content rules strip most of a long page's
  // paragraphs, they have misfired (an article body inside a `.widget`, say).
  // Redo the page keeping everything except the semantic page furniture.
  if opts.only_main_content && opts.include_tags.is_empty() && prose_before >= 2_000 {
    let prose_after = paragraph_chars(&cleaned);
    if prose_after * 100 < prose_before * 35 {
      let again = kuchikiki::parse_html().one(raw_html.as_str());
      keep_content_headers(&again);
      strip_page_furniture(&again);
      cleaned = transform(
        again,
        false,
        &[
          "header",
          "footer",
          "nav",
          "aside",
          "[role=navigation]",
          "[role=banner]",
          "[role=contentinfo]",
        ],
      )
      .map_err(parse_err)?;
    }
  }

  if opts.only_main_content && opts.include_tags.is_empty() {
    strip_edge_link_blocks(&cleaned);
  }

  let md = html::post_process_markdown_text(&markdown::document_to_markdown(&cleaned));
  if formats.contains(&Format::Markdown) {
    data.insert("markdown".into(), Value::String(md.clone()));
  }
  if formats.contains(&Format::Html) {
    data.insert("html".into(), Value::String(cleaned.to_string()));
  }
  if formats.contains(&Format::RawHtml) {
    data.insert("rawHtml".into(), Value::String(raw_html));
  }
  Ok((data, metadata, md))
}

const CONSENT_SELECTORS: &str = "#onetrust-consent-sdk, #onetrust-banner-sdk, #CybotCookiebotDialog, #cookie-law-info-bar, \
  #cookieConsent, .cc-window, .cc-banner, [id*=\"cookie-banner\" i], [class*=\"cookie-banner\" i], [id*=\"cookie-consent\" i], \
  [class*=\"cookie-consent\" i], [id*=\"cookie-notice\" i], [class*=\"cookie-notice\" i], [id*=\"cookieconsent\" i], \
  [class*=\"cookieconsent\" i], [id*=\"consent-banner\" i], [class*=\"consent-banner\" i], [id*=\"gdpr\" i], [class*=\"gdpr\" i], \
  [id*=\"cookie-bar\" i], [class*=\"cookie-bar\" i], [id*=\"cookiebar\" i], [class*=\"cookiebar\" i]";

fn has_descendant(node: &kuchikiki::NodeRef, selector: &str) -> bool {
  node
    .select(selector)
    .map(|mut i| i.next().is_some())
    .unwrap_or(false)
}

/// Remove, in place, two kinds of clutter the shared main-content rules miss:
/// cookie and consent banners, and small sign-up or search forms sitting in
/// the middle of content. Anything holding real content (a heading, an
/// article, a table, a lot of text) is left alone.
fn strip_page_furniture(document: &kuchikiki::NodeRef) {
  let mut doomed: Vec<kuchikiki::NodeRef> = Vec::new();
  if let Ok(banners) = document.select(CONSENT_SELECTORS) {
    for b in banners {
      let node = b.as_node();
      if node.text_contents().len() < 2_500
        && !has_descendant(node, "h1, article, main, table, pre")
      {
        doomed.push(node.clone());
      }
    }
  }
  if let Ok(forms) = document.select("form") {
    for f in forms {
      let node = f.as_node();
      let small = node.text_contents().trim().len() < 500;
      let has_fields = has_descendant(node, "input, select, textarea, button");
      if small
        && has_fields
        && !has_descendant(node, "h1, h2, article, main, table, pre, p + p + p")
      {
        doomed.push(node.clone());
      }
    }
  }
  for node in doomed {
    node.detach();
  }
}

/// Text measurements of one subtree, in non-whitespace characters.
#[derive(Default, Clone, Copy)]
struct TextStats {
  text: usize,
  link_text: usize,
  links: usize,
}

/// One element seen while measuring the page, with its place in document
/// order: `start` on the way in, `end` once its subtree is done.
struct Measured {
  node: kuchikiki::NodeRef,
  start: usize,
  end: usize,
  stats: TextStats,
  tag: String,
  after_heading: bool,
}

fn measure(
  node: &kuchikiki::NodeRef,
  in_link: bool,
  counter: &mut usize,
  out: &mut Vec<Measured>,
) -> TextStats {
  let mut stats = TextStats::default();
  let mut previous_was_heading = false;
  for child in node.children() {
    if let Some(text) = child.as_text() {
      let n = text.borrow().chars().filter(|c| !c.is_whitespace()).count();
      stats.text += n;
      if in_link {
        stats.link_text += n;
      }
      continue;
    }
    let Some(element) = child.as_element() else {
      continue;
    };
    let tag = element.name.local.to_string();
    let is_link = tag == "a";
    *counter += 1;
    let start = *counter;
    let inner = measure(&child, in_link || is_link, counter, out);
    *counter += 1;
    stats.text += inner.text;
    stats.link_text += inner.link_text;
    stats.links += inner.links + usize::from(is_link);
    let is_heading = matches!(tag.as_str(), "h1" | "h2" | "h3" | "h4" | "h5" | "h6");
    out.push(Measured {
      node: child.clone(),
      start,
      end: *counter,
      stats: TextStats {
        links: inner.links + usize::from(is_link),
        ..inner
      },
      tag,
      after_heading: previous_was_heading,
    });
    previous_was_heading = is_heading;
  }
  stats
}

/// Remove, in place, menus and footer link rows that survive the shared
/// main-content rules because the site builds them from plain `<div>`s.
///
/// Deliberately narrow. A block goes only when all of this holds: the page
/// has real prose; the block sits wholly before the first or after the last
/// paragraph of it; it is short, nearly all link text, with three or more
/// short links; and no heading introduces it (a "See also" list stays). A
/// short copyright line after the last paragraph goes too. Pages that are
/// themselves lists of links have no prose to anchor on and are left alone.
fn strip_edge_link_blocks(document: &kuchikiki::NodeRef) {
  let mut measured = Vec::new();
  let mut counter = 0;
  measure(document, false, &mut counter, &mut measured);

  let prose = |m: &Measured| {
    matches!(m.tag.as_str(), "p" | "blockquote" | "pre" | "dd")
      && m.stats.text - m.stats.link_text >= 60
  };
  let anchors: Vec<&Measured> = measured.iter().filter(|m| prose(m)).collect();
  let prose_chars: usize = anchors
    .iter()
    .map(|m| m.stats.text - m.stats.link_text)
    .sum();
  if anchors.len() < 2 || prose_chars < 500 {
    return;
  }
  let content_start = anchors.iter().map(|m| m.start).min().unwrap_or(0);
  let content_end = anchors.iter().map(|m| m.end).max().unwrap_or(usize::MAX);

  let mut doomed: Vec<kuchikiki::NodeRef> = Vec::new();
  for m in &measured {
    let outside = m.end < content_start || m.start > content_end;
    if !outside || m.after_heading {
      continue;
    }
    let block = matches!(
      m.tag.as_str(),
      "ul" | "ol" | "menu" | "nav" | "div" | "p" | "section" | "aside" | "footer" | "table" | "dl"
    );
    if !block || m.stats.text == 0 {
      continue;
    }
    let link_row = m.stats.links >= 3
      && m.stats.text <= 500
      && m.stats.link_text * 100 >= m.stats.text * 80
      && m.stats.link_text / m.stats.links <= 30
      && !has_descendant(&m.node, "h1, h2, h3, img, picture, video, pre, form");
    let copyright = m.start > content_end && m.stats.text <= 200 && m.stats.links <= 6 && {
      let text = m.node.text_contents().to_lowercase();
      text.contains('©') || text.contains("all rights reserved") || text.contains("(c) 20")
    };
    if link_row || copyright {
      doomed.push(m.node.clone());
    }
  }
  for node in doomed {
    node.detach();
  }
}

/// Characters of text inside `<p>` elements: a cheap measure of how much
/// prose a page holds.
fn paragraph_chars(document: &kuchikiki::NodeRef) -> usize {
  match document.select("p") {
    Ok(ps) => ps.map(|p| p.text_contents().trim().len()).sum(),
    Err(_) => 0,
  }
}

/// The main-content rules drop every `<header>`, which also drops the title
/// of an article written as `<article><header><h1>`. Unwrap, in place,
/// headers that sit inside the page's content and hold a heading, so the
/// title survives.
fn keep_content_headers(document: &kuchikiki::NodeRef) {
  let Ok(selection) = document.select("article header, main header, [role=main] header") else {
    return;
  };
  let headers: Vec<_> = selection
    .filter(|h| {
      let node = h.as_node();
      let has_heading = node
        .select("h1, h2, h3")
        .map(|mut i| i.next().is_some())
        .unwrap_or(false);
      let has_nav = node
        .select("nav, [role=navigation]")
        .map(|mut i| i.next().is_some())
        .unwrap_or(false);
      has_heading && !has_nav
    })
    .collect();
  for header in headers {
    let node = header.as_node();
    let children: Vec<_> = node.children().collect();
    for child in children {
      node.insert_before(child);
    }
    node.detach();
  }
}

fn finish_metadata(
  metadata: &mut Map<String, Value>,
  requested: &Url,
  final_url: &str,
  status: u16,
  content_type: Option<&str>,
  engine: &str,
) {
  metadata.insert("sourceURL".into(), Value::String(requested.to_string()));
  metadata.insert("url".into(), Value::String(final_url.to_string()));
  metadata.insert("statusCode".into(), json!(status));
  if let Some(ct) = content_type {
    metadata.insert("contentType".into(), Value::String(ct.to_string()));
  }
  metadata.insert("engine".into(), Value::String(engine.to_string()));
  metadata.insert("creditsUsed".into(), json!(0));
}

/// Non-whitespace characters, the measure of how much a page actually says.
fn visible_chars(markdown: &str) -> usize {
  markdown.chars().filter(|c| !c.is_whitespace()).count()
}

pub fn parse_url(input: &str) -> Result<Url, ScrapeError> {
  let trimmed = input.trim();
  let candidate = if trimmed.contains("://") {
    trimmed.to_string()
  } else {
    format!("https://{trimmed}")
  };
  Url::parse(&candidate)
    .map_err(|e| ScrapeError::new(400, "BAD_REQUEST", format!("Invalid URL '{input}': {e}")))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn cleaned_text(html: &str) -> String {
    use kuchikiki::traits::TendrilSink;
    let document = kuchikiki::parse_html().one(html);
    strip_edge_link_blocks(&document);
    document
      .text_contents()
      .split_whitespace()
      .collect::<Vec<_>>()
      .join(" ")
  }

  const PROSE: &str = "<p>The first paragraph of the article says something long enough to count as real prose on a page, well past sixty characters.</p>\
    <p>The second paragraph keeps going so the page clearly has an article in it, with more than five hundred characters of text overall, \
    which is what tells the cleaner that menus around it are furniture and not the content itself. It needs to be reasonably long, so here \
    is another sentence, and one more after it to be safely over the bar that the rule sets for itself before it removes anything at all. \
    A last sentence pads the paragraph out a little further, because the bar counts letters and not the spaces between the words.</p>";

  #[test]
  fn edge_menus_and_footer_rows_are_dropped() {
    let html = format!(
      "<body><div><a href=/>HOME</a> <a href=/f>FOTO'S</a> <a href=/c>CONTACT</a> <a href=/d>DIENSTEN</a></div>\
       <h1>Title</h1>{PROSE}\
       <div><a href=/t>Terms of use</a> <a href=/p>Privacy Policy</a> <a href=/x>Disclaimer</a> <a href=/q>FAQ</a></div>\
       <div>© Example 2026 All rights reserved.</div></body>"
    );
    let text = cleaned_text(&html);
    assert!(
      text.contains("Title")
        && text.contains("first paragraph")
        && text.contains("sets for itself")
    );
    assert!(!text.contains("DIENSTEN"), "{text}");
    assert!(!text.contains("Privacy Policy"), "{text}");
    assert!(!text.contains("All rights reserved"), "{text}");
  }

  #[test]
  fn link_lists_that_are_content_stay() {
    // A list a heading introduces, links inside the article, and a page that is only links.
    let html = format!(
      "<body><h1>Title</h1>{PROSE}<ul><li><a href=/in>inside one</a></li><li><a href=/in2>inside two</a></li><li><a href=/in3>inside three</a></li></ul>\
       <p>A closing paragraph that is also long enough to count as prose, so the list above sits inside the content.</p>\
       <h2>See also</h2><ul><li><a href=/a>Alpha</a></li><li><a href=/b>Beta</a></li><li><a href=/c>Gamma</a></li></ul></body>"
    );
    let text = cleaned_text(&html);
    assert!(
      text.contains("inside two") && text.contains("Alpha") && text.contains("Gamma"),
      "{text}"
    );

    let hub = "<body><ul><li><a href=/a>Alpha</a></li><li><a href=/b>Beta</a></li><li><a href=/c>Gamma</a></li><li><a href=/d>Delta</a></li></ul></body>";
    assert!(cleaned_text(hub).contains("Delta"));

    // Long link titles after the article (related reading) are not a menu.
    let related = format!(
      "<body>{PROSE}<div><a href=/1>A much longer related article headline that reads as a title</a> \
       <a href=/2>Another long related article headline that reads as a title</a> \
       <a href=/3>A third long related article headline that reads as a title</a></div></body>"
    );
    assert!(cleaned_text(&related).contains("third long related"));
  }

  #[test]
  fn formats_default_and_objects() {
    let o = ScrapeOptions::default();
    assert_eq!(o.resolved_formats().0, vec![Format::Markdown]);

    let o: ScrapeOptions = serde_json::from_value(json!({
      "formats": ["markdown", {"type": "json", "schema": {}}, "links", "summary"],
      "onlyMainContent": false,
      "somethingNew": 1
    }))
    .unwrap();
    let (known, unknown) = o.resolved_formats();
    assert_eq!(known, vec![Format::Markdown, Format::Links]);
    assert_eq!(unknown, vec!["json".to_string(), "summary".to_string()]);
    assert!(!o.only_main_content);
  }

  #[test]
  fn links_resolved_and_deduped() {
    let base = Url::parse("https://example.com/docs/page").unwrap();
    let links = resolve_links(
      vec![
        "/a".into(),
        "b".into(),
        "#frag".into(),
        "https://other.dev/x".into(),
        "/a".into(),
        "javascript:void(0)".into(),
        "mailto:hi@example.com".into(),
      ],
      &base,
    );
    assert_eq!(
      links,
      vec![
        "https://example.com/a",
        "https://example.com/docs/b",
        "https://other.dev/x",
        "mailto:hi@example.com"
      ]
    );
  }

  #[test]
  fn a_page_that_needs_a_browser_says_so() {
    let none = browser_warning(BrowserMode::Auto, false, &Render::NotNeeded).unwrap();
    assert!(none.contains("No Chrome or Chromium") && none.contains("FIRECRAWL_CHROME_PATH"));
    let failed = browser_warning(
      BrowserMode::Auto,
      true,
      &Render::Failed("Chrome could not start.".into()),
    )
    .unwrap();
    assert!(
      failed.contains("could not render it. Chrome could not start."),
      "{failed}"
    );
    // A render that was thrown away leaves the JavaScript shell, so it warns too.
    let rejected = browser_warning(BrowserMode::Auto, true, &Render::Rejected).unwrap();
    assert!(rejected.contains("plain fetch was kept"), "{rejected}");
    // Rendered fine, or turned off on purpose: nothing to say.
    assert!(browser_warning(BrowserMode::Auto, true, &Render::NotNeeded).is_none());
    assert!(browser_warning(BrowserMode::Never, false, &Render::NotNeeded).is_none());
  }

  #[test]
  fn warnings_add_up() {
    let mut data = Map::new();
    add_warning(&mut data, "First.");
    add_warning(&mut data, "Second.");
    assert_eq!(data["warning"], "First. Second.");
  }

  #[test]
  fn bare_host_gets_https() {
    assert_eq!(
      parse_url("example.com/a").unwrap().as_str(),
      "https://example.com/a"
    );
    assert!(parse_url("http://").is_err());
  }
}
