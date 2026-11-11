//! `firecrawl-engine mcp`: a Model Context Protocol server over stdio.
//!
//! Scrape, crawl and map run on this machine. Search goes to Firecrawl cloud.
//! Tool results are plain content plus a few data fields; they never contain
//! instructions for the agent.

use std::{path::PathBuf, sync::Arc};

use futures::stream::{self, StreamExt};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::{
  cloud::{self, Cloud},
  crawl::{self, CrawlOptions, MapOptions},
  scrape::{Engine, ScrapeOptions},
};

const PROTOCOL_VERSION: &str = "2025-06-18";
const DEFAULT_MAX_CHARS: usize = 60_000;

fn tools() -> Value {
  json!([
    {
      "name": "firecrawl_scrape",
      "description": "Read one web page as clean markdown. Runs on this machine: fast, free, and able to reach localhost and private pages. Use it for any URL you already know.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "url": { "type": "string", "description": "The page to read." },
          "onlyMainContent": { "type": "boolean", "description": "Drop navigation, headers and footers. Default true." },
          "formats": { "type": "array", "items": { "type": "string", "enum": ["markdown", "html", "rawHtml", "links"] }, "description": "Default [\"markdown\"]." },
          "maxChars": { "type": "integer", "description": "Cut the returned text at this many characters. Default 60000." },
          "alexandria": { "description": "Run an Alexandria data provider instead of reading a URL: {provider, capability, options}, or an array of up to 10. Get the names and inputs from firecrawl_find_tools. Runs on Firecrawl cloud and needs an account." }
        }
      }
    },
    {
      "name": "firecrawl_find_tools",
      "description": "Find Alexandria data providers: typed, sourced records for companies, people, filings, repositories, research, prices and more. Use it when the task is really a data lookup, or before scraping the same fields from many pages of one site. Returns each provider's inputs, outputs and cost. Runs on Firecrawl cloud.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "query": { "type": "string", "description": "What data you need, in plain words." },
          "urls": { "type": "array", "items": { "type": "string" }, "description": "Find providers for these websites." },
          "providers": { "type": "array", "items": { "type": "string" } },
          "capabilities": { "type": "array", "items": { "type": "string" } },
          "limit": { "type": "integer" }
        }
      }
    },
    {
      "name": "firecrawl_batch_scrape",
      "description": "Read several web pages at once as clean markdown. Much faster than calling firecrawl_scrape once per URL.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "urls": { "type": "array", "items": { "type": "string" }, "description": "Pages to read, up to 100." },
          "onlyMainContent": { "type": "boolean" },
          "maxCharsPerPage": { "type": "integer", "description": "Default 20000." }
        },
        "required": ["urls"]
      }
    },
    {
      "name": "firecrawl_map",
      "description": "List the URLs of a website from its sitemaps and start page, without reading the pages. Use it to find the right page before scraping.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "url": { "type": "string" },
          "search": { "type": "string", "description": "Only URLs containing this text." },
          "limit": { "type": "integer", "description": "Default 500." }
        },
        "required": ["url"]
      }
    },
    {
      "name": "firecrawl_crawl",
      "description": "Read many pages of one website, following links from a start URL. Give outputDir to save each page as a markdown file and get back an index instead of the full text.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "url": { "type": "string" },
          "limit": { "type": "integer", "description": "Maximum pages. Default 25." },
          "maxDiscoveryDepth": { "type": "integer" },
          "includePaths": { "type": "array", "items": { "type": "string" } },
          "excludePaths": { "type": "array", "items": { "type": "string" } },
          "crawlEntireDomain": { "type": "boolean" },
          "outputDir": { "type": "string", "description": "Directory to write one .md file per page." }
        },
        "required": ["url"]
      }
    },
    {
      "name": "firecrawl_search",
      "description": "Search the web. Runs on Firecrawl cloud, because a search index does not fit on this machine.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "query": { "type": "string" },
          "limit": { "type": "integer", "description": "Default 5." },
          "scrapeResults": { "type": "integer", "description": "Also read this many of the top results on this machine and return their full text. Default 0, at most 5." }
        },
        "required": ["query"]
      }
    }
  ])
}

fn truncate_chars(text: &str, max: usize) -> (String, bool) {
  if text.len() <= max {
    return (text.to_string(), false);
  }
  let mut end = max;
  while end > 0 && !text.is_char_boundary(end) {
    end -= 1;
  }
  (text[..end].to_string(), true)
}

fn text_result(text: String, is_error: bool) -> Value {
  json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
}

fn page_block(doc: &Value, max_chars: usize) -> String {
  let meta = doc.get("metadata").cloned().unwrap_or(Value::Null);
  let title = meta.get("title").and_then(Value::as_str).unwrap_or("");
  let url = meta.get("url").and_then(Value::as_str).unwrap_or("");
  let status = meta.get("statusCode").and_then(Value::as_u64).unwrap_or(0);
  let source = doc.get("source").and_then(Value::as_str).unwrap_or("local");
  let mut out = format!("url: {url}\ntitle: {title}\nstatus: {status}\nsource: {source}\n");
  if let Some(credits) = meta.get("creditsUsed").and_then(Value::as_u64) {
    out.push_str(&format!("credits: {credits}\n"));
  }
  if let Some(md) = doc.get("markdown").and_then(Value::as_str) {
    let (text, cut) = truncate_chars(md, max_chars);
    if cut {
      out.push_str(&format!(
        "truncated: true (showing {} of {} characters)\n",
        text.len(),
        md.len()
      ));
    }
    out.push_str("\n");
    out.push_str(&text);
    out.push('\n');
  }
  for key in ["links", "html", "rawHtml"] {
    if let Some(v) = doc.get(key) {
      let rendered = match v {
        Value::String(s) => s.clone(),
        Value::Array(a) => a
          .iter()
          .filter_map(Value::as_str)
          .collect::<Vec<_>>()
          .join("\n"),
        other => other.to_string(),
      };
      let (text, _) = truncate_chars(&rendered, max_chars);
      out.push_str(&format!("\n--- {key} ---\n{text}\n"));
    }
  }
  out
}

struct Server {
  engine: Arc<Engine>,
  cloud: Arc<std::sync::Mutex<Cloud>>,
  /// A sign-in the person has been sent a link for and not finished yet.
  pending_login: Arc<std::sync::Mutex<Option<crate::login::LoginSession>>>,
}

impl Server {
  fn cloud(&self) -> Cloud {
    self
      .cloud
      .lock()
      .map(|c| c.clone())
      .unwrap_or_else(|e| e.into_inner().clone())
  }

  /// Turn a cloud refusal into a result. When the refusal is "you need an
  /// account", attach a one-step sign-in link and wait for it in the
  /// background: once the person signs in, the key is saved and the next
  /// call simply works.
  fn cloud_error(&self, e: cloud::CloudError) -> Value {
    let needs_account = matches!(e.status, 401 | 402 | 403 | 429) && !self.cloud().has_key();
    if !needs_account {
      return text_result(e.message, true);
    }
    match self.sign_in_link() {
      Some(url) => text_result(
        format!(
          "{}\n\nsign_in_url: {url}\nOpening that link signs in with Google or GitHub. The key is saved automatically; no copying, no restart.",
          e.message
        ),
        true,
      ),
      None => text_result(e.message, true),
    }
  }

  fn sign_in_link(&self) -> Option<String> {
    let mut pending = self.pending_login.lock().ok()?;
    if let Some(session) = pending.as_ref() {
      return Some(session.url.clone());
    }
    let session = crate::login::LoginSession::start().ok()?;
    let url = session.url.clone();
    *pending = Some(session.clone());
    let (cloud, slot) = (self.cloud.clone(), self.pending_login.clone());
    tokio::spawn(async move {
      if let Ok(signed_in) = session.wait(std::time::Duration::from_secs(900)).await {
        let _ = crate::login::save(&signed_in);
        if let Ok(mut c) = cloud.lock() {
          *c = c.clone().with_key(signed_in.api_key);
        }
      }
      if let Ok(mut p) = slot.lock() {
        *p = None;
      }
    });
    Some(url)
  }

  async fn scrape_one(&self, url: &str, opts: &ScrapeOptions) -> Result<Value, String> {
    cloud::scrape_with_fallback(&self.engine, &self.cloud(), url, opts)
      .await
      .map_err(|e| format!("{} ({})", e.message, e.code))
  }

  fn data_result(payload: &Value, max: usize) -> Value {
    let credits = payload
      .pointer("/data/creditsCost")
      .or_else(|| payload.get("creditsUsed"))
      .and_then(Value::as_u64);
    let body = payload.pointer("/data/alexandria").unwrap_or(payload);
    let rendered = serde_json::to_string_pretty(body).unwrap_or_default();
    let (text, cut) = truncate_chars(&rendered, max);
    let mut out = String::from("source: firecrawl-cloud\n");
    if let Some(c) = credits {
      out.push_str(&format!("credits: {c}\n"));
    }
    if cut {
      out.push_str(&format!(
        "truncated: true (showing {} of {} characters)\n",
        text.len(),
        rendered.len()
      ));
    }
    out.push('\n');
    out.push_str(&text);
    text_result(out, false)
  }

  async fn call(&self, name: &str, args: &Value) -> Value {
    match name {
      "firecrawl_scrape" => {
        let max = args
          .get("maxChars")
          .and_then(Value::as_u64)
          .map(|n| n as usize)
          .unwrap_or(DEFAULT_MAX_CHARS);
        if let Some(calls) = args.get("alexandria") {
          return match self.cloud().alexandria(calls).await {
            Ok(payload) => Self::data_result(&payload, max),
            Err(e) => self.cloud_error(e),
          };
        }
        let Some(url) = args.get("url").and_then(Value::as_str) else {
          return text_result(
            "Give a 'url' to read a page, or 'alexandria' to run a data provider.".into(),
            true,
          );
        };
        let opts: ScrapeOptions = serde_json::from_value(args.clone()).unwrap_or_default();
        match self.scrape_one(url, &opts).await {
          Ok(doc) => {
            let mut text = page_block(&doc, max);
            if doc.get("blocked").and_then(Value::as_bool) == Some(true) {
              text.push_str("\nblocked: true\n");
            }
            text_result(text, false)
          }
          Err(e) => text_result(format!("Could not read {url}: {e}"), true),
        }
      }
      "firecrawl_batch_scrape" => {
        let urls: Vec<String> = args
          .get("urls")
          .and_then(Value::as_array)
          .map(|a| {
            a.iter()
              .filter_map(|v| v.as_str().map(str::to_string))
              .take(100)
              .collect()
          })
          .unwrap_or_default();
        if urls.is_empty() {
          return text_result("The 'urls' argument needs at least one URL.".into(), true);
        }
        let opts: ScrapeOptions = serde_json::from_value(args.clone()).unwrap_or_default();
        let max = args
          .get("maxCharsPerPage")
          .and_then(Value::as_u64)
          .map(|n| n as usize)
          .unwrap_or(20_000);
        let blocks: Vec<String> = stream::iter(urls.into_iter().map(|url| {
          let opts = opts.clone();
          async move {
            match self.scrape_one(&url, &opts).await {
              Ok(doc) => page_block(&doc, max),
              Err(e) => format!("url: {url}\nerror: {e}\n"),
            }
          }
        }))
        .buffered(16)
        .collect()
        .await;
        text_result(blocks.join("\n=====\n"), false)
      }
      "firecrawl_find_tools" => {
        let mut options = args.clone();
        if !options.is_object() {
          options = json!({});
        }
        match self.cloud().find_tools(&options).await {
          Ok(payload) => Self::data_result(&payload, DEFAULT_MAX_CHARS),
          Err(e) => self.cloud_error(e),
        }
      }
      "firecrawl_map" => {
        let Some(url) = args.get("url").and_then(Value::as_str) else {
          return text_result("The 'url' argument is required.".into(), true);
        };
        let mut opts: MapOptions = serde_json::from_value(args.clone()).unwrap_or_default();
        if args.get("limit").is_none() {
          opts.limit = 500;
        }
        match crawl::map(self.engine.clone(), url, &opts).await {
          Ok(links) => text_result(
            format!("count: {}\n\n{}", links.len(), links.join("\n")),
            false,
          ),
          Err(e) => text_result(format!("Could not map {url}: {}", e.message), true),
        }
      }
      "firecrawl_crawl" => {
        let Some(url) = args.get("url").and_then(Value::as_str) else {
          return text_result("The 'url' argument is required.".into(), true);
        };
        let mut opts: CrawlOptions = serde_json::from_value(args.clone()).unwrap_or_default();
        if args.get("limit").is_none() {
          opts.limit = 25;
        }
        let out_dir = args
          .get("outputDir")
          .and_then(Value::as_str)
          .map(PathBuf::from);
        match crawl::crawl(self.engine.clone(), url, &opts, |_| {}).await {
          Ok(outcome) => {
            let mut text = format!(
              "pages: {}\nerrors: {}\nskipped_by_robots: {}\nsource: local\n\n",
              outcome.pages.len(),
              outcome.errors.len(),
              outcome.robots_blocked.len()
            );
            match out_dir {
              Some(dir) => match write_pages(&dir, &outcome.pages).await {
                Ok(index) => {
                  text.push_str(&format!(
                    "saved_to: {}\n\n{}",
                    dir.display(),
                    index.join("\n")
                  ));
                }
                Err(e) => {
                  return text_result(format!("Crawled, but could not write files: {e}"), true)
                }
              },
              None => {
                let per_page =
                  (DEFAULT_MAX_CHARS / outcome.pages.len().max(1)).clamp(1_500, 20_000);
                let blocks: Vec<String> = outcome
                  .pages
                  .iter()
                  .map(|p| page_block(p, per_page))
                  .collect();
                text.push_str(&blocks.join("\n=====\n"));
              }
            }
            text_result(text, false)
          }
          Err(e) => text_result(format!("Could not crawl {url}: {}", e.message), true),
        }
      }
      "firecrawl_search" => {
        let Some(query) = args.get("query").and_then(Value::as_str) else {
          return text_result("The 'query' argument is required.".into(), true);
        };
        let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(5) as u32;
        let read_top = args
          .get("scrapeResults")
          .and_then(Value::as_u64)
          .unwrap_or(0)
          .min(5) as usize;
        match self.cloud().search(query, limit).await {
          Ok(payload) => {
            let results = payload
              .pointer("/data/web")
              .or_else(|| payload.get("data"))
              .and_then(Value::as_array)
              .cloned()
              .unwrap_or_default();
            let mut text = format!("source: firecrawl-cloud\nresults: {}\n", results.len());
            if let Some(credits) = payload.get("creditsUsed").and_then(Value::as_u64) {
              text.push_str(&format!("credits: {credits}\n"));
            }
            for (i, r) in results.iter().enumerate() {
              text.push_str(&format!(
                "\n{}. {}\n   {}\n   {}\n",
                i + 1,
                r.get("title").and_then(Value::as_str).unwrap_or(""),
                r.get("url").and_then(Value::as_str).unwrap_or(""),
                r.get("description").and_then(Value::as_str).unwrap_or("")
              ));
            }
            // The search ran in the cloud; the pages are read here, for free.
            if read_top > 0 {
              let urls: Vec<String> = results
                .iter()
                .filter_map(|r| r.get("url").and_then(Value::as_str).map(str::to_string))
                .take(read_top)
                .collect();
              let opts = ScrapeOptions::default();
              let blocks: Vec<String> = stream::iter(urls.into_iter().map(|url| {
                let opts = opts.clone();
                async move {
                  match self.scrape_one(&url, &opts).await {
                    Ok(doc) => page_block(&doc, 12_000),
                    Err(e) => format!("url: {url}\nerror: {e}\n"),
                  }
                }
              }))
              .buffered(5)
              .collect()
              .await;
              text.push_str("\n===== full text of the top results =====\n");
              text.push_str(&blocks.join("\n=====\n"));
            }
            text_result(text, false)
          }
          Err(e) => self.cloud_error(e),
        }
      }
      other => text_result(format!("Unknown tool '{other}'."), true),
    }
  }

  async fn handle(&self, msg: Value) -> Option<Value> {
    let id = msg.get("id").cloned();
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    // Notifications carry no id and get no reply.
    let id = id?;
    let result = match method {
      "initialize" => {
        let harness = params
          .pointer("/clientInfo/name")
          .and_then(Value::as_str)
          .map(str::to_string);
        if let Ok(mut c) = self.cloud.lock() {
          *c = c
            .clone()
            .with_surface(crate::cloud::Surface::Mcp, harness.as_deref())
            .with_harness(harness);
        }
        let version = params
          .get("protocolVersion")
          .and_then(Value::as_str)
          .unwrap_or(PROTOCOL_VERSION);
        json!({
          "protocolVersion": version,
          "capabilities": { "tools": { "listChanged": false } },
          "serverInfo": { "name": "firecrawl", "title": "Firecrawl", "version": env!("CARGO_PKG_VERSION") },
          "instructions": "Firecrawl reads the web for you. firecrawl_scrape, firecrawl_batch_scrape, firecrawl_map and firecrawl_crawl run on this machine. firecrawl_search and firecrawl_find_tools run on Firecrawl cloud, as do Alexandria data providers."
        })
      }
      "ping" => json!({}),
      "tools/list" => json!({ "tools": tools() }),
      "tools/call" => {
        let name = params.get("name").and_then(Value::as_str).unwrap_or("");
        let args = params
          .get("arguments")
          .cloned()
          .unwrap_or_else(|| json!({}));
        self.call(name, &args).await
      }
      "resources/list" => json!({ "resources": [] }),
      "prompts/list" => json!({ "prompts": [] }),
      _ => {
        return Some(json!({
          "jsonrpc": "2.0",
          "id": id,
          "error": { "code": -32601, "message": format!("Method not found: {method}") }
        }))
      }
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
  }
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
      "---\nurl: {url}\ntitle: {}\n---\n\n{md}\n",
      title.replace('\n', " ")
    );
    tokio::fs::write(dir.join(&name), body)
      .await
      .map_err(|e| format!("{name}: {e}"))?;
    index.push(format!("{name}\t{url}\t{title}"));
  }
  Ok(index)
}

pub async fn run(engine: Arc<Engine>, cloud: Cloud) -> Result<(), String> {
  let server = Server {
    engine,
    cloud: Arc::new(std::sync::Mutex::new(cloud)),
    pending_login: Arc::new(std::sync::Mutex::new(None)),
  };
  let mut lines = BufReader::new(tokio::io::stdin()).lines();
  let mut stdout = tokio::io::stdout();
  while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
    let line = line.trim();
    if line.is_empty() {
      continue;
    }
    let reply = match serde_json::from_str::<Value>(line) {
      Ok(msg) => server.handle(msg).await,
      Err(e) => Some(json!({
        "jsonrpc": "2.0",
        "id": null,
        "error": { "code": -32700, "message": format!("Parse error: {e}") }
      })),
    };
    if let Some(reply) = reply {
      let mut bytes = serde_json::to_vec(&reply).map_err(|e| e.to_string())?;
      bytes.push(b'\n');
      stdout.write_all(&bytes).await.map_err(|e| e.to_string())?;
      stdout.flush().await.map_err(|e| e.to_string())?;
    }
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn truncation_respects_char_boundaries() {
    let (t, cut) = truncate_chars("héllo wörld", 2);
    assert!(cut);
    assert_eq!(t, "h");
    let (t, cut) = truncate_chars("short", 100);
    assert!(!cut);
    assert_eq!(t, "short");
  }

  #[test]
  fn file_names_are_safe() {
    let name = file_name_for("https://example.com/docs/a b?x=1", 0);
    assert_eq!(name, "0001-example.com_docs_a_b_x_1.md");
  }

  #[test]
  fn tool_list_has_five_tools_with_schemas() {
    let t = tools();
    let arr = t.as_array().unwrap();
    assert_eq!(arr.len(), 6);
    for tool in arr {
      assert!(tool["name"].as_str().unwrap().starts_with("firecrawl_"));
      assert_eq!(tool["inputSchema"]["type"], "object");
    }
  }
}
