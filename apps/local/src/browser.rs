//! JavaScript rendering through the Chrome already installed on this machine.
//!
//! Nothing is downloaded. Chrome runs headless, sandboxed, in a throwaway
//! profile: never the person's own profile, cookies or logins. It starts on
//! the first page that needs it and is reused after that.

use std::{
  path::PathBuf,
  sync::{Arc, Mutex as StdMutex},
  time::{Duration, Instant},
};

use chromiumoxide::{
  browser::{Browser, BrowserConfig},
  cdp::browser_protocol::network::{
    EventLoadingFailed, EventLoadingFinished, EventRequestWillBeSent, ResourceType,
  },
  page::ScreenshotParams,
};
use futures::StreamExt;
use tokio::sync::{Mutex, Semaphore};
use url::Url;

use crate::guard::{self, NetworkPolicy};

/// Counts fetch and XHR calls still in flight, so "the page has settled" can
/// mean "nothing is still loading", not just "the text stopped changing".
const NETWORK_TRACKER: &str = r#"(() => {
  if (window.__fcTracker) return;
  window.__fcTracker = true;
  // Requests still open. One that has been open for more than 1.5 s is a
  // long poll or a stream, not the page loading, so it stops counting.
  const open = new Set();
  Object.defineProperty(window, '__fcPending', {
    configurable: true,
    get() {
      const now = performance.now();
      let n = 0;
      for (const r of open) if (now - r.at < 1500) n++;
      return n;
    },
  });
  window.__fcLastMut = performance.now();
  try {
    new MutationObserver(() => { window.__fcLastMut = performance.now(); })
      .observe(document, { subtree: true, childList: true, characterData: true });
  } catch (e) {}
  const begin = () => {
    const r = { at: performance.now() };
    open.add(r);
    return () => { open.delete(r); };
  };
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function () {
      const done = begin();
      const p = origFetch.apply(this, arguments);
      p.then(done, done);
      return p;
    };
  }
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('loadend', begin(), { once: true });
    return origSend.apply(this, arguments);
  };
})()"#;

/// Serialises the page with open shadow roots flattened into their hosts, so
/// content inside web components is not lost. Returns null when the page has
/// no shadow roots and the normal serialisation is enough.
const FLATTEN_SHADOW_DOM: &str = r#"(() => {
  let has = false;
  for (const el of document.querySelectorAll('*')) { if (el.shadowRoot) { has = true; break; } }
  if (!has) return null;
  const VOID = new Set(['area','base','br','col','embed','hr','img','input','link','meta','source','track','wbr']);
  const SKIP = new Set(['script','style','noscript','template','svg']);
  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const escA = s => s.replace(/&/g,'&amp;').replace(/"/g,'&quot;');
  const ser = n => {
    if (n.nodeType === 3) return esc(n.nodeValue);
    if (n.nodeType !== 1) return '';
    const t = n.localName;
    if (SKIP.has(t)) return '';
    let a = '';
    for (const at of n.attributes) a += ' ' + at.name + '="' + escA(at.value) + '"';
    if (VOID.has(t)) return '<' + t + a + '>';
    let inner = '';
    if (n.shadowRoot) for (const c of n.shadowRoot.childNodes) inner += ser(c);
    for (const c of n.childNodes) inner += ser(c);
    return '<' + t + a + '>' + inner + '</' + t + '>';
  };
  return '<!doctype html>' + ser(document.documentElement);
})()"#;

/// Watches the page's network requests through the DevTools protocol, so the
/// engine can tell "still loading scripts and data" from "done".
struct NetWatch {
  in_flight: Arc<StdMutex<std::collections::HashMap<String, (Instant, String)>>>,
  last_event: Arc<StdMutex<Instant>>,
  /// The address of the latest document request, which after a redirect is
  /// not the address the page was asked for.
  last_document: Arc<StdMutex<Option<String>>>,
  tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl NetWatch {
  async fn start(page: &chromiumoxide::Page) -> Self {
    let in_flight = Arc::new(StdMutex::new(std::collections::HashMap::new()));
    let last_event = Arc::new(StdMutex::new(Instant::now()));
    let last_document = Arc::new(StdMutex::new(None));
    let mut tasks = Vec::new();
    if let Ok(mut events) = page.event_listener::<EventRequestWillBeSent>().await {
      let (set, last) = (in_flight.clone(), last_event.clone());
      let document = last_document.clone();
      tasks.push(tokio::spawn(async move {
        while let Some(e) = events.next().await {
          if e.r#type == Some(ResourceType::Document) {
            if let Ok(mut d) = document.lock() {
              *d = Some(e.request.url.clone());
            }
          }
          if let Ok(mut s) = set.lock() {
            s.insert(
              e.request_id.inner().clone(),
              (Instant::now(), e.request.url.clone()),
            );
          }
          if let Ok(mut l) = last.lock() {
            *l = Instant::now();
          }
        }
      }));
    }
    if let Ok(mut events) = page.event_listener::<EventLoadingFinished>().await {
      let (set, last) = (in_flight.clone(), last_event.clone());
      tasks.push(tokio::spawn(async move {
        while let Some(e) = events.next().await {
          if let Ok(mut s) = set.lock() {
            s.remove(e.request_id.inner());
          }
          if let Ok(mut l) = last.lock() {
            *l = Instant::now();
          }
        }
      }));
    }
    if let Ok(mut events) = page.event_listener::<EventLoadingFailed>().await {
      let (set, last) = (in_flight.clone(), last_event.clone());
      tasks.push(tokio::spawn(async move {
        while let Some(e) = events.next().await {
          if let Ok(mut s) = set.lock() {
            s.remove(e.request_id.inner());
          }
          if let Ok(mut l) = last.lock() {
            *l = Instant::now();
          }
        }
      }));
    }
    Self {
      in_flight,
      last_event,
      last_document,
      tasks,
    }
  }

  fn last_document(&self) -> Option<String> {
    self.last_document.lock().ok().and_then(|d| d.clone())
  }

  /// True when the network has gone quiet: nothing started or finished for
  /// a third of a second and no recent request is still in flight. A request open
  /// for more than 1.5 seconds is a long-lived connection or one that will
  /// never report back (a beacon, a blocked script), not "still loading";
  /// slow data calls are still caught by the in-page fetch and XHR counter.
  fn idle(&self) -> bool {
    let quiet = self
      .last_event
      .lock()
      .map(|l| l.elapsed())
      .unwrap_or_default();
    let pending = self
      .in_flight
      .lock()
      .map(|s| {
        s.values()
          .filter(|(started, _)| started.elapsed() < Duration::from_millis(1500))
          .count()
      })
      .unwrap_or(0);
    pending == 0 && quiet >= Duration::from_millis(350)
  }

  fn stop(self) {
    for t in self.tasks {
      t.abort();
    }
  }
}

pub struct Rendered {
  pub html: String,
  pub final_url: String,
  pub status: Option<u16>,
  pub screenshot_png: Option<Vec<u8>>,
}

struct Launched {
  browser: Browser,
  handler: tokio::task::JoinHandle<()>,
  profile: PathBuf,
  /// Every connection Chrome makes goes through this; dropped with Chrome.
  _proxy: crate::netguard::GuardProxy,
}

pub struct BrowserPool {
  chrome: PathBuf,
  policy: NetworkPolicy,
  user_agent: String,
  launched: Mutex<Option<Launched>>,
  pages: Semaphore,
}

/// Find a Chromium-family browser. `FIRECRAWL_CHROME_PATH` wins.
pub fn find_chrome() -> Option<PathBuf> {
  if let Some(p) = std::env::var_os("FIRECRAWL_CHROME_PATH").map(PathBuf::from) {
    if p.exists() {
      return Some(p);
    }
  }
  let fixed = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  if let Some(p) = fixed.iter().map(PathBuf::from).find(|p| p.exists()) {
    return Some(p);
  }
  let path = std::env::var_os("PATH")?;
  for dir in std::env::split_paths(&path) {
    for name in [
      "google-chrome",
      "google-chrome-stable",
      "chromium",
      "chromium-browser",
      "chrome",
    ] {
      let candidate = dir.join(name);
      if candidate.exists() {
        return Some(candidate);
      }
    }
  }
  None
}

impl BrowserPool {
  pub fn new(policy: NetworkPolicy, user_agent: &str, max_pages: usize) -> Option<Arc<Self>> {
    let chrome = find_chrome()?;
    Some(Arc::new(Self {
      chrome,
      policy,
      user_agent: user_agent.to_string(),
      launched: Mutex::new(None),
      pages: Semaphore::new(max_pages.max(1)),
    }))
  }

  async fn ensure_launched(&self) -> Result<(), String> {
    let mut guard = self.launched.lock().await;
    if guard.is_some() {
      return Ok(());
    }
    let profile = std::env::temp_dir().join(format!(
      "firecrawl-local-chrome-{}-{}",
      std::process::id(),
      uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&profile)
      .map_err(|e| format!("could not create a browser profile: {e}"))?;
    // Chrome does its own networking, so it is sent through a loopback proxy
    // that applies the network policy to every connection it opens: the
    // page, its redirects, subresources, scripts' requests and WebSockets.
    let proxy = crate::netguard::GuardProxy::start(self.policy)
      .await
      .map_err(|e| format!("could not start the browser's network guard: {e}"))?;
    let config = BrowserConfig::builder()
      .chrome_executable(&self.chrome)
      .user_data_dir(&profile)
      .new_headless_mode()
      .respect_https_errors()
      .window_size(1366, 900)
      .launch_timeout(Duration::from_secs(20))
      .request_timeout(Duration::from_secs(45))
      .args([
        "disable-gpu",
        "mute-audio",
        "hide-scrollbars",
        "no-default-browser-check",
        "disable-notifications",
        "disable-save-password-bubble",
      ])
      .args(proxy.chrome_args())
      .build()
      .map_err(|e| format!("browser configuration failed: {e}"))?;
    let (browser, mut handler) = Browser::launch(config)
      .await
      .map_err(|e| chrome_start_error(&self.chrome, &e.to_string()))?;
    let handler = tokio::spawn(async move {
      while let Some(event) = handler.next().await {
        if event.is_err() {
          break;
        }
      }
    });
    *guard = Some(Launched {
      browser,
      handler,
      profile,
      _proxy: proxy,
    });
    Ok(())
  }

  /// Load a page, let it settle, and return its rendered HTML.
  pub async fn render(
    &self,
    url: &Url,
    wait_for: Duration,
    timeout: Duration,
    screenshot: bool,
  ) -> Result<Rendered, String> {
    guard::check_url(url, self.policy).map_err(|e| e.0)?;
    let _permit = self.pages.acquire().await.map_err(|e| e.to_string())?;
    self.ensure_launched().await?;

    let page = {
      let guard = self.launched.lock().await;
      let launched = guard.as_ref().ok_or("browser is not running")?;
      launched
        .browser
        .new_page("about:blank")
        .await
        .map_err(|e| format!("could not open a tab: {e}"))?
    };

    let result = tokio::time::timeout(timeout, self.drive(&page, url, wait_for, screenshot)).await;
    let _ = page.close().await;
    match result {
      Ok(r) => r,
      Err(_) => Err("the page did not finish loading in time".to_string()),
    }
  }

  async fn drive(
    &self,
    page: &chromiumoxide::Page,
    url: &Url,
    wait_for: Duration,
    screenshot: bool,
  ) -> Result<Rendered, String> {
    page
      .set_user_agent(self.user_agent.as_str())
      .await
      .map_err(|e| format!("could not set the user agent: {e}"))?;
    let _ = page.evaluate_on_new_document(NETWORK_TRACKER).await;
    let watch = NetWatch::start(page).await;
    let result = self
      .drive_watched(page, url, wait_for, screenshot, &watch)
      .await;
    watch.stop();
    result
  }

  async fn drive_watched(
    &self,
    page: &chromiumoxide::Page,
    url: &Url,
    wait_for: Duration,
    screenshot: bool,
    watch: &NetWatch,
  ) -> Result<Rendered, String> {
    if let Err(e) = page.goto(url.as_str()).await {
      // The guard may have refused this address or one it redirected to.
      let mut reason = crate::netguard::refusal_reason(url, self.policy).await;
      if reason.is_none() {
        if let Some(redirected) = watch.last_document().and_then(|u| Url::parse(&u).ok()) {
          reason = crate::netguard::refusal_reason(&redirected, self.policy).await;
        }
      }
      return Err(reason.unwrap_or_else(|| format!("navigation failed: {e}")));
    }
    let response = page.wait_for_navigation_response().await.ok().flatten();

    // Which address each connection reaches is enforced by the guard proxy
    // Chrome runs behind, for this response and everything else the page
    // loads, so there is nothing further to check here.
    let status = response
      .as_ref()
      .and_then(|r| r.response.as_ref())
      .map(|resp| resp.status as u16);

    let trace = std::env::var_os("FIRECRAWL_LOCAL_TRACE").is_some();
    let t0 = Instant::now();
    settle(page, watch, Duration::from_secs(10), true).await;
    if trace {
      eprintln!("[render] first settle {:?}", t0.elapsed());
      if let Ok(open) = watch.in_flight.lock() {
        for (started, url) in open.values() {
          eprintln!(
            "[render] still open after {:?}: {}",
            started.elapsed(),
            &url[..url.len().min(120)]
          );
        }
      }
    }
    // Lazy-loaded content only appears once it scrolls into view. Wait again
    // only if scrolling actually made the page load or change something.
    let before_scroll = Instant::now();
    // Scrolling costs most of a second per rendered page and helped on few
    // pages in testing, so it is opt-in: FIRECRAWL_LOCAL_SCROLL=1.
    let scrolled =
      std::env::var_os("FIRECRAWL_LOCAL_SCROLL").is_some() && scroll_through(page).await;
    let changed = scrolled && page_changed_since(page, watch, before_scroll).await;
    if changed {
      settle(page, watch, Duration::from_millis(2500), false).await;
    }
    if trace {
      eprintln!(
        "[render] scrolled={scrolled} changed={changed} total {:?}",
        t0.elapsed()
      );
    }
    if !wait_for.is_zero() {
      tokio::time::sleep(wait_for).await;
    }

    let final_url = page
      .url()
      .await
      .ok()
      .flatten()
      .unwrap_or_else(|| url.to_string());
    if let Ok(parsed) = Url::parse(&final_url) {
      // A page that navigated itself somewhere forbidden is discarded.
      guard::check_url(&parsed, self.policy).map_err(|e| e.0)?;
    }

    let flattened = match page.evaluate(FLATTEN_SHADOW_DOM).await {
      Ok(v) => v.into_value::<Option<String>>().ok().flatten(),
      Err(_) => None,
    };
    let html = match flattened {
      Some(html) => html,
      None => page
        .content()
        .await
        .map_err(|e| format!("could not read the page: {e}"))?,
    };
    let screenshot_png = if screenshot {
      page
        .screenshot(ScreenshotParams::builder().full_page(true).build())
        .await
        .ok()
    } else {
      None
    };

    Ok(Rendered {
      html,
      final_url,
      status,
      screenshot_png,
    })
  }

  /// Stop Chrome and delete its throwaway profile.
  pub async fn shutdown(&self) {
    if let Some(mut launched) = self.launched.lock().await.take() {
      let _ = launched.browser.close().await;
      let _ = tokio::time::timeout(Duration::from_secs(3), launched.browser.wait()).await;
      launched.handler.abort();
      let _ = std::fs::remove_dir_all(&launched.profile);
    }
  }
}

/// Wait until the page has really finished: the document is complete, the
/// network is idle, no fetch or XHR is in flight, and neither the DOM nor the
/// text has changed for about half a second. A page with no text yet gets up
/// to three seconds to produce some.
async fn settle(
  page: &chromiumoxide::Page,
  watch: &NetWatch,
  budget: Duration,
  wait_for_text: bool,
) {
  let started = Instant::now();
  let empty_budget = if wait_for_text {
    Duration::from_secs(3).min(budget)
  } else {
    Duration::ZERO
  };
  let probe = "(() => document.readyState + ':' + (window.__fcPending || 0) + ':' + (document.body ? document.body.innerText.length : 0) + ':' + Math.round(performance.now() - (window.__fcLastMut || 0)))()";
  let mut last_text = usize::MAX;
  let mut stable = 0u8;
  while started.elapsed() < budget {
    let now = match page.evaluate(probe).await {
      Ok(v) => v.into_value::<String>().unwrap_or_default(),
      Err(_) => String::new(),
    };
    let mut parts = now.split(':');
    let complete = parts.next() == Some("complete");
    let pending: usize = parts.next().and_then(|n| n.parse().ok()).unwrap_or(0);
    let text_len: usize = parts.next().and_then(|n| n.parse().ok()).unwrap_or(0);
    let dom_quiet_ms: u64 = parts.next().and_then(|n| n.parse().ok()).unwrap_or(0);
    if std::env::var_os("FIRECRAWL_LOCAL_TRACE").is_some() {
      eprintln!(
        "[settle] {:?} state={now} net_idle={}",
        started.elapsed(),
        watch.idle()
      );
    }
    if complete && pending == 0 && watch.idle() && dom_quiet_ms >= 300 && text_len == last_text {
      stable += 1;
      let has_text = text_len >= 50;
      if stable >= 2 && (has_text || started.elapsed() >= empty_budget) {
        return;
      }
    } else {
      stable = 0;
    }
    last_text = text_len;
    tokio::time::sleep(Duration::from_millis(100)).await;
  }
}

/// True when a request started or finished, or the DOM changed, after `since`.
async fn page_changed_since(page: &chromiumoxide::Page, watch: &NetWatch, since: Instant) -> bool {
  let network = watch.last_event.lock().map(|l| *l > since).unwrap_or(false);
  if network {
    return true;
  }
  let dom_quiet_ms = match page
    .evaluate("(() => Math.round(performance.now() - (window.__fcLastMut || 0)))()")
    .await
  {
    Ok(v) => v.into_value::<u64>().unwrap_or(u64::MAX),
    Err(_) => u64::MAX,
  };
  Duration::from_millis(dom_quiet_ms) < since.elapsed()
}

/// Scroll a tall page to the bottom in steps and back to the top. Returns
/// false, without scrolling, when the page fits in a couple of screens.
async fn scroll_through(page: &chromiumoxide::Page) -> bool {
  let tall = match page
    .evaluate("(() => document.documentElement.scrollHeight > window.innerHeight * 2)()")
    .await
  {
    Ok(v) => v.into_value::<bool>().unwrap_or(false),
    Err(_) => false,
  };
  if !tall {
    return false;
  }
  for _ in 0..8 {
    let at_bottom = match page
      .evaluate("(() => { window.scrollBy(0, window.innerHeight * 2); return window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4; })()")
      .await
    {
      Ok(v) => v.into_value::<bool>().unwrap_or(true),
      Err(_) => true,
    };
    tokio::time::sleep(Duration::from_millis(80)).await;
    if at_bottom {
      break;
    }
  }
  let _ = page.evaluate("window.scrollTo(0, 0)").await;
  true
}

/// True when a fetched page is a JavaScript shell that needs a browser.
///
/// Signals, strongest first: the page says it needs JavaScript or carries a
/// framework mount point and has little text; or it has scripts and almost
/// no text; or its text is a tiny share of its HTML (data waiting in scripts).
/// A short static page with an analytics tag is none of these.
pub fn needs_browser(raw_html: &str, markdown: &str) -> bool {
  let visible = markdown.chars().filter(|c| !c.is_whitespace()).count();
  if visible >= 1500 {
    return false;
  }
  let mut end = raw_html.len().min(200_000);
  while !raw_html.is_char_boundary(end) {
    end -= 1;
  }
  let head = raw_html[..end].to_ascii_lowercase();
  if !head.contains("<script") {
    return false;
  }
  let asks_for_js = head.contains("enable javascript")
    || head.contains("requires javascript")
    || head.contains("javascript is disabled")
    || head.contains("javascript is required")
    || head.contains("need to enable javascript");
  let mount_point = [
    "id=\"root\"",
    "id=\"app\"",
    "id=\"__next\"",
    "id=\"__nuxt\"",
    "id=\"svelte\"",
    "id=\"___gatsby\"",
    "data-reactroot",
    "ng-app",
    "ng-view",
    "ng-version",
    "<app-root",
    "id=\"q-app\"",
    "id=\"elm\"",
  ]
  .iter()
  .any(|m| head.contains(m));
  if asks_for_js || mount_point {
    return true;
  }
  let ratio = visible as f64 / raw_html.len().max(1) as f64;
  // Text is under 1% of a sizeable page: the content is waiting in scripts.
  if ratio < 0.01 && raw_html.len() > 20_000 {
    return true;
  }
  if visible >= 300 {
    return false;
  }
  visible < 60 || ratio < 0.03
}

/// Share of a markdown document's visible text that is link text. Pages that
/// are nearly all links are navigation, not content.
pub fn link_text_share(markdown: &str) -> f64 {
  let mut total = 0usize;
  let mut in_links = 0usize;
  let mut depth = 0usize;
  let mut pending = 0usize;
  let mut chars = markdown.chars().peekable();
  while let Some(c) = chars.next() {
    match c {
      '[' => {
        depth += 1;
        pending = 0;
      }
      ']' if depth > 0 => {
        depth -= 1;
        if chars.peek() == Some(&'(') {
          in_links += pending;
          // Skip the URL: it is not visible text.
          for u in chars.by_ref() {
            if u == ')' {
              break;
            }
          }
        }
        pending = 0;
      }
      c if !c.is_whitespace() => {
        total += 1;
        if depth > 0 {
          pending += 1;
        }
      }
      _ => {}
    }
  }
  if total == 0 {
    0.0
  } else {
    in_links as f64 / total as f64
  }
}

/// True when a server-rendered framework page came back as navigation with
/// no body: it has an app mount point, a modest amount of text, and most of
/// that text is links.
pub fn looks_like_nav_only_shell(raw_html: &str, markdown: &str) -> bool {
  let visible = markdown.chars().filter(|c| !c.is_whitespace()).count();
  if !(1500..12_000).contains(&visible) {
    return false;
  }
  let mut end = raw_html.len().min(200_000);
  while !raw_html.is_char_boundary(end) {
    end -= 1;
  }
  let head = raw_html[..end].to_ascii_lowercase();
  let framework = [
    "id=\"__nuxt\"",
    "id=\"__next\"",
    "id=\"root\"",
    "id=\"app\"",
    "ng-version",
    "<app-root",
    "id=\"___gatsby\"",
    "id=\"svelte\"",
  ]
  .iter()
  .any(|m| head.contains(m));
  framework && link_text_share(markdown) > 0.6
}

/// Target of an instant `<meta http-equiv="refresh">` redirect, if the page
/// is one.
pub fn meta_refresh_target(raw_html: &str, base: &Url) -> Option<Url> {
  if raw_html.len() > 100_000 {
    return None;
  }
  let lower = raw_html.to_ascii_lowercase();
  let at = lower
    .find("http-equiv=\"refresh\"")
    .or_else(|| lower.find("http-equiv='refresh'"))
    .or_else(|| lower.find("http-equiv=refresh"))?;
  let tag_start = lower[..at].rfind("<meta")?;
  let tag_end = at + lower[at..].find('>')?;
  let tag = &raw_html[tag_start..tag_end];
  let tag_lower = &lower[tag_start..tag_end];
  let content_at = tag_lower.find("content=")? + "content=".len();
  let value = tag[content_at..].trim_start_matches(['"', '\'']);
  let value_lower = value.to_ascii_lowercase();
  let delay: f64 = value
    .split(|c| c == ';' || c == ',')
    .next()
    .and_then(|d| d.trim().parse().ok())
    .unwrap_or(99.0);
  if delay > 5.0 {
    return None;
  }
  let url_at = value_lower.find("url=")? + "url=".len();
  let target = value[url_at..]
    .trim_start_matches(['"', '\''])
    .split(|c| c == '"' || c == '\'' || c == '>')
    .next()?
    .trim();
  if target.is_empty() {
    return None;
  }
  let resolved = base.join(target).ok()?;
  if resolved == *base {
    None
  } else {
    Some(resolved)
  }
}

/// Why Chrome did not start, in words someone can act on. Chrome's own
/// message runs to several hundred characters of log line.
fn chrome_start_error(chrome: &std::path::Path, detail: &str) -> String {
  if detail.contains("No usable sandbox") {
    return format!(
      "Chrome at {} could not start its sandbox, which usually means a container or system policy blocks user namespaces. In Docker, run the container with a seccomp profile that allows them; the Firecrawl Local README shows one. On Ubuntu 23.10 or newer, allow user namespaces for Chrome. Firecrawl Local does not run Chrome without its sandbox.",
      chrome.display()
    );
  }
  let short: String = detail.chars().take(300).collect();
  format!("could not start Chrome at {}: {short}", chrome.display())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_sandbox_failure_is_explained() {
    let chrome = std::path::Path::new("/usr/bin/chromium");
    let said = chrome_start_error(
      chrome,
      "Browser process exited ... No usable sandbox! If this is a Debian system ...",
    );
    assert!(
      said.contains("seccomp profile") && said.contains("/usr/bin/chromium"),
      "{said}"
    );
    // Turning the whole filter off is not what it recommends.
    assert!(!said.contains("unconfined"), "{said}");
    assert!(!said.contains("Debian system"));
    let other = chrome_start_error(chrome, &"x".repeat(2000));
    assert!(other.len() < 400);
  }

  #[test]
  fn link_share_and_nav_only_shells() {
    assert!((link_text_share("[abcd](https://x.dev/long/url) ef") - 4.0 / 6.0).abs() < 1e-9);
    assert_eq!(link_text_share("plain text only"), 0.0);
    let nav: String = (0..200)
      .map(|i| format!("- [Section number {i}](https://x.dev/s/{i})\n"))
      .collect();
    let html = "<html><body><div id=\"__nuxt\"><nav></nav></div><script src=\"/a.js\"></script></body></html>";
    assert!(looks_like_nav_only_shell(html, &nav));
    let article = "word ".repeat(800);
    assert!(!looks_like_nav_only_shell(html, &article));
    assert!(!looks_like_nav_only_shell(
      "<html><body><nav></nav></body></html>",
      &nav
    ));
  }

  #[test]
  fn meta_refresh_is_followed_only_when_instant() {
    let base = Url::parse("https://blog.example.com/2024/old.html").unwrap();
    let html = "<html><head><meta http-equiv=\"refresh\" content=\"0; url=/2024/new/\"></head><body>Redirecting</body></html>";
    assert_eq!(
      meta_refresh_target(html, &base).unwrap().as_str(),
      "https://blog.example.com/2024/new/"
    );
    let quoted = "<meta http-equiv='refresh' content='0;URL=https://other.dev/x'>";
    assert_eq!(
      meta_refresh_target(quoted, &base).unwrap().as_str(),
      "https://other.dev/x"
    );
    let slow = "<meta http-equiv=\"refresh\" content=\"300; url=/reload\">";
    assert!(meta_refresh_target(slow, &base).is_none());
    assert!(meta_refresh_target("<html><body>plain</body></html>", &base).is_none());
  }

  #[test]
  fn shell_detection() {
    let shell =
      "<html><body><div id=\"root\"></div><script src=\"/app.js\"></script></body></html>";
    assert!(needs_browser(shell, ""));
    let article = format!(
      "<html><body><p>{}</p><script></script></body></html>",
      "word ".repeat(200)
    );
    assert!(!needs_browser(&article, &"word ".repeat(200)));
    // A short static page with no scripts is just short.
    assert!(!needs_browser("<html><body><p>Hi</p></body></html>", "Hi"));
    // Little text, lots of markup and data in scripts: render it.
    let data_page = format!(
      "<html><body><div class=\"quotes\"></div><script>var data = [{}];</script></body></html>",
      "{\"text\":\"q\"},".repeat(400)
    );
    assert!(needs_browser(&data_page, &"word ".repeat(20)));
    // A framework mount point with some text around it: render it.
    let app = format!(
      "<html><body><div ng-view></div><p>{}</p><script src=\"/app.js\"></script></body></html>",
      "word ".repeat(80)
    );
    assert!(needs_browser(&app, &"word ".repeat(80)));
    // A short static page with an analytics script is still just short.
    let small = format!(
      "<html><body><p>{}</p><script src=\"/a.js\"></script></body></html>",
      "word ".repeat(30)
    );
    assert!(!needs_browser(&small, &"word ".repeat(30)));
  }
}
